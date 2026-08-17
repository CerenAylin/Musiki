/**
 * Musiki — content.js
 * YouTube sayfasında çalışan content script.
 * - inject.js'i enjekte eder (YT Player API erişimi)
 * - 4 adet <audio> elementi yönetir (stems)
 * - YouTube player ile senkronizasyon sağlar
 * - Web Audio API ile frekans analizi yapar
 * - AudioWorklet ile gerçek zamanlı pitch shifting (transpoze)
 * - Popup ile port bağlantısı üzerinden haberleşir
 */
(function () {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────
  const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];
  const BACKEND_URL = 'http://localhost:8765';

  let audioElements = {};    // { vocals: Audio, drums: Audio, ... }
  let audioContext = null;
  let analysers = {};        // { vocals: AnalyserNode, ... }
  let gainNodes = {};        // { vocals: GainNode, ... }
  let pitchNodes = {};       // { vocals: AudioWorkletNode, ... }
  let pitchShifterReady = false;
  let isLoaded = false;
  let isSyncing = false;
  let syncRAF = null;
  let popupPort = null;

  let ytState = {
    currentTime: 0,
    state: -1,      // -1:unstarted, 0:ended, 1:playing, 2:paused, 3:buffering
    duration: 0,
    volume: 100,
    isMuted: false
  };
  let lastYtTimeUpdate = performance.now();

  // Kanal kontrolleri
  let volumes = { vocals: 1.0, drums: 1.0, bass: 1.0, other: 1.0 };
  let muted = { vocals: false, drums: false, bass: false, other: false };
  let soloChannel = null;
  let masterVolume = 100;
  let currentSemitones = 0;
  let stemsActive = true;

  // Video ID takibi (SPA navigasyon desteği)
  let currentVideoId = getVideoId();

  // ─── Inject Bridge Script ───────────────────────────────────────
  function injectBridge() {
    if (document.getElementById('musiki-inject')) return;

    const script = document.createElement('script');
    script.id = 'musiki-inject';
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = () => {
      console.log('[Musiki Content] inject.js enjekte edildi');
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // ─── YouTube Player State Listener ──────────────────────────────
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'MUSIKI_YT_STATE') return;

    ytState = event.data.payload;
    lastYtTimeUpdate = performance.now();

    // Popup'a her zaman güncelle
    if (popupPort) {
      try {
        popupPort.postMessage({
          action: 'stateSync',
          isLoaded,
          volumes,
          muted,
          soloChannel,
          videoId: currentVideoId,
          transpose: currentSemitones,
          stemsActive,
          playerState: {
            currentTime: ytState.currentTime,
            duration: ytState.duration,
            state: ytState.state
          }
        });
      } catch(e) {
        popupPort = null;
      }
    }
  });

  // ─── Audio Management ──────────────────────────────────────────
  async function loadStems(stemsUrls) {
    console.log('[Musiki Content] Stem\'ler yükleniyor...', stemsUrls);

    // Önceki audio'ları temizle
    cleanup();

    // AudioContext oluştur
    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Pitch shifter worklet'i yükle
    try {
      const workletUrl = chrome.runtime.getURL('pitch-shifter-worklet.js');
      await audioContext.audioWorklet.addModule(workletUrl);
      pitchShifterReady = true;
      console.log('[Musiki Content] 🎵 PitchShifter worklet yüklendi');
    } catch (e) {
      console.warn('[Musiki Content] PitchShifter worklet yüklenemedi, transpoze devre dışı:', e);
      pitchShifterReady = false;
    }

    const loadPromises = [];

    STEM_NAMES.forEach(name => {
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.preload = 'auto';
      audio.src = BACKEND_URL + stemsUrls[name];

      // Web Audio API bağlantıları
      const source = audioContext.createMediaElementSource(audio);
      const gain = audioContext.createGain();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;

      gainNodes[name] = gain;
      analysers[name] = analyser;
      audioElements[name] = audio;

      // Audio zinciri: source → gain → [pitchShifter →] analyser → destination
      source.connect(gain);

      if (pitchShifterReady) {
        try {
          const pitchNode = new AudioWorkletNode(audioContext, 'pitch-shifter');
          pitchNodes[name] = pitchNode;

          // Mevcut transpoze değerini uygula
          if (currentSemitones !== 0) {
            pitchNode.port.postMessage({ semitones: currentSemitones });
          }

          gain.connect(pitchNode);
          pitchNode.connect(analyser);
        } catch (e) {
          console.warn(`[Musiki Content] ${name} için pitchShifter oluşturulamadı:`, e);
          gain.connect(analyser);
        }
      } else {
        gain.connect(analyser);
      }

      analyser.connect(audioContext.destination);

      // Yüklenme promise'i
      loadPromises.push(new Promise((resolve, reject) => {
        audio.addEventListener('canplaythrough', resolve, { once: true });
        audio.addEventListener('error', (e) => {
          console.error(`[Musiki Content] ${name} yüklenemedi:`, e);
          reject(e);
        }, { once: true });
      }));
    });

    // Tüm stem'ler yüklendiğinde
    Promise.all(loadPromises)
      .then(() => {
        isLoaded = true;
        stemsActive = true;
        console.log('[Musiki Content] ✅ Tüm stem\'ler yüklendi!');

        // YouTube sesini kapat
        window.postMessage({ type: 'MUSIKI_COMMAND', action: 'mute' }, '*');

        // Senkronizasyonu başlat
        startSync();

        // Volume'ları uygula
        applyAllVolumes();

        // Popup'a bildir
        sendToPopup({ action: 'stemsLoaded' });
      })
      .catch(err => {
        console.error('[Musiki Content] Stem yükleme hatası:', err);
        sendToPopup({ action: 'error', error: 'Stem dosyaları yüklenemedi' });
      });
  }

  // ─── Sync Loop ─────────────────────────────────────────────────
  function startSync() {
    if (isSyncing) return;
    isSyncing = true;

    function syncFrame() {
      if (!isLoaded) {
        isSyncing = false;
        return;
      }

      if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().catch(()=> { });
      }

      const ytPlaying = ytState.state === 1;
      let estimatedYtTime = ytState.currentTime;
      if (ytPlaying) {
        estimatedYtTime += (performance.now() - lastYtTimeUpdate) / 1000;
      }

      STEM_NAMES.forEach(name => {
        const audio = audioElements[name];
        if (!audio) return;

        // Zaman senkronizasyonu — drift büyükse düzelt
        const threshold = ytPlaying ? 0.3 : 0.1;
        const drift = Math.abs(audio.currentTime - estimatedYtTime);
        if (drift > threshold) {
          audio.currentTime = estimatedYtTime;
        }

        // Play/Pause senkronizasyonu
        if (stemsActive && ytPlaying) {
          if (audio.paused) {
            audio.play().catch(() => { });
          }
        } else {
          if (!audio.paused) {
            audio.pause();
          }
        }
      });

      // Popup'a durum gönder
      if (popupPort) {
        sendVisualizationData();
      }

      syncRAF = requestAnimationFrame(syncFrame);
    }

    syncRAF = requestAnimationFrame(syncFrame);
    console.log('[Musiki Content] 🔄 Senkronizasyon başlatıldı');
  }

  function stopSync() {
    if (syncRAF) {
      cancelAnimationFrame(syncRAF);
      syncRAF = null;
    }
    isSyncing = false;
  }

  // ─── Visualization Data ────────────────────────────────────────
  function sendVisualizationData() {
    if (!popupPort || !isLoaded) return;

    const vizData = {};

    STEM_NAMES.forEach(name => {
      const analyser = analysers[name];
      if (!analyser) return;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyser.getByteFrequencyData(dataArray);

      const reduced = [];
      const step = Math.floor(bufferLength / 16);
      for (let i = 0; i < 16; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) {
          sum += dataArray[i * step + j];
        }
        reduced.push(Math.round(sum / step));
      }

      vizData[name] = reduced;
    });

    try {
      popupPort.postMessage({
        action: 'vizData',
        data: vizData,
        playerState: {
          currentTime: ytState.currentTime,
          duration: ytState.duration,
          state: ytState.state
        }
      });
    } catch (e) {
      popupPort = null;
    }
  }

  // ─── Volume Control ────────────────────────────────────────────
  function applyAllVolumes() {
    STEM_NAMES.forEach(name => applyVolume(name));
  }

  function applyVolume(name) {
    const gain = gainNodes[name];
    if (!gain) return;

    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(()=> { });
    }

    let effectiveVolume = volumes[name] * (masterVolume / 100);

    if (muted[name]) {
      effectiveVolume = 0;
    }

    if (soloChannel && soloChannel !== name) {
      effectiveVolume = 0;
    }

    gain.gain.setTargetAtTime(effectiveVolume, audioContext.currentTime, 0.02);
  }

  function setVolume(name, value) {
    volumes[name] = value;
    applyVolume(name);
  }

  function toggleMute(name) {
    muted[name] = !muted[name];
    applyVolume(name);
    return muted[name];
  }

  function toggleSolo(name) {
    if (soloChannel === name) {
      soloChannel = null;
    } else {
      soloChannel = name;
    }
    applyAllVolumes();
    return soloChannel;
  }

  // ─── Transpose Control ────────────────────────────────────────
  function setTranspose(semitones) {
    currentSemitones = semitones;
    console.log(`[Musiki Content] 🎵 Transpoze: ${semitones > 0 ? '+' : ''}${semitones} yarım ton`);

    STEM_NAMES.forEach(name => {
      if (pitchNodes[name]) {
        pitchNodes[name].port.postMessage({ semitones });
      }
    });
  }

  // ─── Communication with Popup ──────────────────────────────────
  chrome.runtime.onConnect.addListener(function (port) {
    if (port.name !== 'musiki-viz') return;

    console.log('[Musiki Content] 🔌 Popup bağlandı');
    popupPort = port;

    // Popup'a mevcut durumu gönder
    port.postMessage({
      action: 'stateSync',
      isLoaded,
      volumes,
      muted,
      soloChannel,
      videoId: currentVideoId,
      transpose: currentSemitones,
      stemsActive,
      playerState: {
        currentTime: ytState.currentTime,
        duration: ytState.duration,
        state: ytState.state
      }
    });

    port.onMessage.addListener(function (msg) {
      switch (msg.action) {
        case 'setVolume':
          setVolume(msg.stem, msg.value);
          break;

        case 'toggleMute': {
          const isMuted = toggleMute(msg.stem);
          port.postMessage({ action: 'muteState', stem: msg.stem, muted: isMuted, soloChannel });
          break;
        }

        case 'toggleSolo': {
          const solo = toggleSolo(msg.stem);
          port.postMessage({ action: 'soloState', soloChannel: solo, muted });
          break;
        }

        case 'seek': {
          const time = ytState.duration * msg.percent;
          window.postMessage({ type: 'MUSIKI_COMMAND', action: 'seek', value: time }, '*');
          // Stem'leri de aynı zamana ayarla
          STEM_NAMES.forEach(name => {
            if (audioElements[name]) {
              audioElements[name].currentTime = time;
            }
          });
          break;
        }

        case 'play':
          window.postMessage({ type: 'MUSIKI_COMMAND', action: 'play' }, '*');
          break;

        case 'pause':
          window.postMessage({ type: 'MUSIKI_COMMAND', action: 'pause' }, '*');
          break;

        case 'setMasterVolume':
          masterVolume = msg.value;
          applyAllVolumes();
          break;

        case 'setTranspose':
          setTranspose(msg.value);
          break;

        case 'syncNow':
          console.log(`[Musiki Content] ⏱ Manuel senkronizasyon: ${ytState.currentTime}s`);
          STEM_NAMES.forEach(name => {
            if (audioElements[name]) {
              // Küçük bir fark olsa bile kesin olarak eşitle
              audioElements[name].currentTime = ytState.currentTime;
            }
          });
          break;

        case 'toggleStems':
          stemsActive = !stemsActive;
          if (stemsActive) {
            window.postMessage({ type: 'MUSIKI_COMMAND', action: 'mute' }, '*');
          } else {
            window.postMessage({ type: 'MUSIKI_COMMAND', action: 'unmute' }, '*');
            // Anında durdur
            STEM_NAMES.forEach(name => {
              if (audioElements[name] && !audioElements[name].paused) {
                audioElements[name].pause();
              }
            });
          }
          port.postMessage({ action: 'stemsActiveState', stemsActive });
          break;

        case 'getState':
          window.postMessage({ type: 'MUSIKI_COMMAND', action: 'getState' }, '*');
          port.postMessage({
            action: 'stateSync',
            isLoaded,
            volumes,
            muted,
            soloChannel,
            videoId: currentVideoId,
            transpose: currentSemitones,
            stemsActive,
            playerState: {
              currentTime: ytState.currentTime,
              duration: ytState.duration,
              state: ytState.state
            }
          });
          break;
      }
    });

    port.onDisconnect.addListener(function () {
      console.log('[Musiki Content] 🔌 Popup bağlantısı kesildi');
      popupPort = null;
    });
  });

  // Background/Popup'tan gelen mesajları dinle
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    switch (msg.action) {
      case 'loadStems':
        loadStems(msg.stems);
        sendResponse({ status: 'loading' });
        break;

      case 'getVideoId':
        sendResponse({ videoId: getVideoId() });
        break;

      case 'isLoaded':
        sendResponse({ loaded: isLoaded, videoId: currentVideoId });
        break;

      case 'restoreYTAudio':
        window.postMessage({ type: 'MUSIKI_COMMAND', action: 'unmute' }, '*');
        cleanup();
        sendResponse({ status: 'restored' });
        break;
    }
    return true;
  });

  // ─── Popup'a mesaj gönder ──────────────────────────────────────
  function sendToPopup(msg) {
    if (popupPort) {
      try {
        popupPort.postMessage(msg);
      } catch (e) {
        popupPort = null;
      }
    }
  }

  // ─── Cleanup ───────────────────────────────────────────────────
  function cleanup() {
    stopSync();

    STEM_NAMES.forEach(name => {
      if (audioElements[name]) {
        audioElements[name].pause();
        audioElements[name].src = '';
        audioElements[name].remove?.();
      }
      // Pitch node'ları temizle
      if (pitchNodes[name]) {
        try { pitchNodes[name].disconnect(); } catch(e) {}
      }
    });

    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(() => { });
    }

    audioElements = {};
    audioContext = null;
    analysers = {};
    gainNodes = {};
    pitchNodes = {};
    pitchShifterReady = false;
    isLoaded = false;
    stemsActive = true;
  }

  // ─── Utility ───────────────────────────────────────────────────
  function getVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('v');
  }

  // ─── SPA Navigation Detection ─────────────────────────────────
  function handleUrlChange() {
    const newVideoId = getVideoId();
    if (newVideoId && newVideoId !== currentVideoId) {
      console.log(`[Musiki Content] 🔄 Video değişti: ${currentVideoId} → ${newVideoId}`);
      currentVideoId = newVideoId;
      cleanup();
      sendToPopup({ action: 'videoChanged', videoId: newVideoId });
    }
  }

  document.addEventListener('yt-navigate-finish', handleUrlChange);
  document.addEventListener('yt-page-data-updated', handleUrlChange);

  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      handleUrlChange();
    }
  }).observe(document, { subtree: true, childList: true });

  // ─── Initialize ───────────────────────────────────────────────
  injectBridge();
  console.log('[Musiki Content] 🎶 Content script yüklendi');
})();
