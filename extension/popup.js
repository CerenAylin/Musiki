/**
 * Musiki — popup.js
 * Popup UI mantığı: backend iletişimi, kanal kontrolleri,
 * görselleştirme yönetimi ve durum senkronizasyonu.
 */

(function () {
  'use strict';

  const BACKEND_URL = 'http://localhost:8765';
  const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];

  // ─── DOM References ────────────────────────────────────────
  const vizCanvas = document.getElementById('vizCanvas');
  const vizOverlay = document.getElementById('vizOverlay');
  const separateBtn = document.getElementById('separateBtn');
  const btnText = separateBtn.querySelector('.btn-text');
  const loadingIndicator = document.getElementById('loadingIndicator');
  const statusText = document.getElementById('statusText');
  const backendDot = document.querySelector('#backendStatus .status-dot');
  const currentTimeEl = document.getElementById('currentTime');
  const durationEl = document.getElementById('duration');
  const progressKnob = document.getElementById('progressKnob');
  const progressTrack = document.getElementById('progressTrack');
  const titleText = document.getElementById('titleText');
  
  const skipBackBtn = document.getElementById('skipBackBtn');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const skipFwdBtn = document.getElementById('skipFwdBtn');
  const masterVolumeSlider = document.getElementById('masterVolumeSlider');
  
  const cancelBtn = document.getElementById('cancelBtn');
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const libraryList = document.getElementById('libraryList');
  const refreshLibraryBtn = document.getElementById('refreshLibraryBtn');
  
  const closePopupBtn = document.getElementById('closePopupBtn');
  const deleteCacheBtn = document.getElementById('deleteCacheBtn');

  // ─── State ─────────────────────────────────────────────────
  let currentTabId = null;
  let currentVideoId = null;
  let contentPort = null;
  let visualizer = null;
  let animFrame = null;
  let isProcessing = false;
  let stemsReady = false;
  let currentPlayerState = null;
  let volumes = { vocals: 100, drums: 100, bass: 100, other: 100 };
  let muted = { vocals: false, drums: false, bass: false, other: false };
  let soloChannel = null;

  // ─── Initialize ────────────────────────────────────────────
  async function init() {
    // Visualizer oluştur
    visualizer = new KandinskyVisualizer(vizCanvas);

    // Aktif sekmeyi bul
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) {
      setStatus('YouTube\'da bir video açın', 'idle');
      separateBtn.disabled = true;
      startIdleAnimation();
      return;
    }

    currentTabId = tab.id;
    currentVideoId = extractVideoId(tab.url);

    if (!currentVideoId) {
      setStatus('Video ID bulunamadı', 'error');
      separateBtn.disabled = true;
      startIdleAnimation();
      return;
    }

    // Backend kontrolü
    checkBackend();

    // Content script'e bağlan
    connectToContentScript();

    // Mevcut durumu kontrol et
    checkExistingState();

    // Kanal ikon çizimi
    drawChannelIcons();

    // Event listener'ları kur
    setupEventListeners();

    // Kütüphaneyi yükle
    loadLibrary();

    // Animasyon başlat
    startIdleAnimation();
  }

  // ─── Backend Health Check ──────────────────────────────────
  async function checkBackend() {
    try {
      const response = await fetch(`${BACKEND_URL}/api/health`);
      if (response.ok) {
        backendDot.classList.add('online');
        backendDot.classList.remove('offline');
        return true;
      }
    } catch (e) {
      // Backend çalışmıyor
    }
    backendDot.classList.add('offline');
    backendDot.classList.remove('online');
    setStatus('Backend çalışmıyor!', 'error');
    separateBtn.disabled = true;
    return false;
  }

  // ─── Content Script Connection ─────────────────────────────
  function connectToContentScript() {
    try {
      contentPort = chrome.tabs.connect(currentTabId, { name: 'musiki-viz' });

      contentPort.onMessage.addListener(handleContentMessage);

      contentPort.onDisconnect.addListener(() => {
        contentPort = null;
      });
    } catch (e) {
      console.warn('Content script\'e bağlanılamadı:', e);
    }
  }

  function handleContentMessage(msg) {
    switch (msg.action) {
      case 'stateSync':
        // Content script'ten mevcut durum
        stemsReady = msg.isLoaded;
        if (msg.isLoaded) {
          onStemsReady();
          volumes = {};
          muted = msg.muted || {};
          soloChannel = msg.soloChannel || null;

          // Volume slider'ları güncelle
          STEM_NAMES.forEach(name => {
            const val = msg.volumes ? Math.round(msg.volumes[name] * 100) : 100;
            volumes[name] = val;
            updateSliderUI(name, val);
            updateMuteUI(name, muted[name]);
          });
          updateSoloUI();
        }
        if (msg.playerState) {
          updatePlayerBar(msg.playerState);
        }
        break;

      case 'vizData':
        // Görselleştirme verisi
        if (visualizer) {
          visualizer.updateFrequencyData(msg.data);
        }
        if (msg.playerState) {
          updatePlayerBar(msg.playerState);
        }
        break;

      case 'stemsLoaded':
        onStemsReady();
        break;

      case 'muteState':
        muted[msg.stem] = msg.muted;
        soloChannel = msg.soloChannel;
        updateMuteUI(msg.stem, msg.muted);
        updateSoloUI();
        break;

      case 'soloState':
        soloChannel = msg.soloChannel;
        updateSoloUI();
        break;

      case 'videoChanged':
        currentVideoId = msg.videoId;
        stemsReady = false;
        resetUI();
        checkExistingState();
        break;

      case 'error':
        setStatus(msg.error, 'error');
        break;
    }
  }

  // ─── Existing State Check ──────────────────────────────────
  async function checkExistingState() {
    // Background'daki tab durumunu kontrol et
    chrome.runtime.sendMessage(
      { action: 'getTabState', tabId: currentTabId },
      (state) => {
        if (state) {
          if (state.status === 'completed' || state.status === 'cached') {
            if (state.title) titleText.textContent = state.title;
            onStemsReady();
          } else if (state.status === 'downloading' || state.status === 'separating') {
            onProcessingStart(state.status);
            if (state.title) titleText.textContent = state.title;
          }
        }
      }
    );

    // Cache kontrolü
    try {
      const response = await fetch(`${BACKEND_URL}/api/status/${currentVideoId}`);
      const data = await response.json();
      if (data.status === 'cached' || data.status === 'completed') {
        if (data.title) titleText.textContent = data.title;
        // Content script'te yüklü mü kontrol et
        chrome.tabs.sendMessage(currentTabId, { action: 'isLoaded' }, (resp) => {
          if (resp && resp.loaded && resp.videoId === currentVideoId) {
            onStemsReady();
          } else {
            setStatus('Önbellekte mevcut — Yeniden yükle', 'cached');
            btnText.textContent = 'Yükle';
          }
        });
      }
    } catch (e) {
      // Backend kapalı olabilir
    }
  }

  // ─── Event Listeners ──────────────────────────────────────
  function setupEventListeners() {
    // Ayrıştır butonu
    separateBtn.addEventListener('click', handleSeparate);
    
    // Durdur butonu
    cancelBtn.addEventListener('click', handleCancel);

    // Sekmeler
    tabBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        document.getElementById('tab' + e.target.dataset.tab.charAt(0).toUpperCase() + e.target.dataset.tab.slice(1)).classList.add('active');
        if (e.target.dataset.tab === 'library') loadLibrary();
      });
    });

    // Kütüphane yenile
    refreshLibraryBtn.addEventListener('click', loadLibrary);

    // Kapatma butonu
    if (closePopupBtn) {
      closePopupBtn.addEventListener('click', () => window.close());
    }

    // Ana ekrandaki silme butonu
    if (deleteCacheBtn) {
      deleteCacheBtn.addEventListener('click', async () => {
        if (!currentVideoId) return;
        try {
          await fetch(`${BACKEND_URL}/api/cache/${currentVideoId}`, { method: 'DELETE' });
          resetUI();
        } catch (e) { console.error(e); }
      });
    }

    // Oynatma Çubuğu Seek
    progressTrack.addEventListener('click', (e) => {
      if (!stemsReady || !contentPort) return;
      const rect = progressTrack.getBoundingClientRect();
      const percent = (e.clientX - rect.left) / rect.width;
      contentPort.postMessage({ action: 'seek', percent });
    });

    // Playback Controls
    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', () => {
        if (!contentPort || !currentPlayerState) return;
        if (currentPlayerState.state === 1) { // 1 = playing
          contentPort.postMessage({ action: 'pause' });
        } else {
          contentPort.postMessage({ action: 'play' });
        }
      });
    }
    if (skipBackBtn) {
      skipBackBtn.addEventListener('click', () => {
        if (!contentPort || !currentPlayerState) return;
        const newTime = Math.max(0, currentPlayerState.currentTime - 10);
        contentPort.postMessage({ action: 'seek', percent: newTime / currentPlayerState.duration });
      });
    }
    if (skipFwdBtn) {
      skipFwdBtn.addEventListener('click', () => {
        if (!contentPort || !currentPlayerState) return;
        const newTime = Math.min(currentPlayerState.duration, currentPlayerState.currentTime + 10);
        contentPort.postMessage({ action: 'seek', percent: newTime / currentPlayerState.duration });
      });
    }
    if (masterVolumeSlider) {
      masterVolumeSlider.addEventListener('input', (e) => {
        if (!contentPort) return;
        contentPort.postMessage({ action: 'setMasterVolume', value: parseInt(e.target.value) });
      });
    }

    // Volume sliders
    document.querySelectorAll('.volume-slider').forEach(slider => {
      slider.addEventListener('input', (e) => {
        const stem = e.target.dataset.stem;
        const value = parseInt(e.target.value);
        volumes[stem] = value;
        updateSliderUI(stem, value);

        if (contentPort) {
          contentPort.postMessage({
            action: 'setVolume',
            stem,
            value: value / 100
          });
        }
      });
    });

    // Mute buttons
    document.querySelectorAll('.mute-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const stem = e.target.dataset.stem;
        if (contentPort) {
          contentPort.postMessage({ action: 'toggleMute', stem });
        }
      });
    });

    // Solo buttons
    document.querySelectorAll('.solo-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const stem = e.target.dataset.stem;
        if (contentPort) {
          contentPort.postMessage({ action: 'toggleSolo', stem });
        }
      });
    });

    // Download buttons
    document.querySelectorAll('.download-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const stem = e.target.dataset.stem;
        if (currentVideoId && stemsReady) {
          downloadStem(stem);
        }
      });
    });

    // Canvas click — shape toggle
    vizCanvas.addEventListener('click', (e) => {
      if (!stemsReady || !visualizer) return;
      const rect = vizCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = visualizer.hitTest(x, y);
      if (hit && contentPort) {
        contentPort.postMessage({ action: 'toggleMute', stem: hit });
      }
    });

    // Canvas hover — cursor change
    vizCanvas.addEventListener('mousemove', (e) => {
      if (!stemsReady || !visualizer) return;
      const rect = vizCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = visualizer.hitTest(x, y);
      vizCanvas.style.cursor = hit ? 'pointer' : 'default';
    });

    // Status updates from background
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.action === 'statusUpdate' && msg.tabId === currentTabId) {
        handleStatusUpdate(msg);
      }
    });
  }

  // ─── Separate Handler ──────────────────────────────────────
  async function handleSeparate() {
    if (isProcessing || !currentVideoId) return;

    const backendOk = await checkBackend();
    if (!backendOk) return;

    onProcessingStart('starting');

    // Background'a gönder
    chrome.runtime.sendMessage({
      action: 'startSeparation',
      videoId: currentVideoId,
      tabId: currentTabId
    });

    // Status polling başlat
    startStatusPolling();
  }

  async function handleCancel() {
    if (!currentVideoId || !isProcessing) return;
    try {
      await fetch(`${BACKEND_URL}/api/cancel/${currentVideoId}`, { method: 'POST' });
    } catch (e) { console.error(e); }
    resetUI();
  }

  // ─── Status Polling ────────────────────────────────────────
  let pollInterval = null;

  function startStatusPolling() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/api/status/${currentVideoId}`);
        const data = await response.json();
        handleStatusUpdate(data);

        if (data.status === 'completed' || data.status === 'cached' || data.status === 'error') {
          clearInterval(pollInterval);
          pollInterval = null;
        }
      } catch (e) {
        // Backend erişilemez
      }
    }, 1500);
  }

  function handleStatusUpdate(data) {
    const status = data.status;

    if (data.title) {
      titleText.textContent = data.title;
    }

    switch (status) {
      case 'downloading':
        setStatus('İndiriliyor...', 'downloading');
        loadingIndicator.className = 'loading-indicator active downloading';
        break;

      case 'separating':
        setStatus('Ayrıştırılıyor...', 'separating');
        loadingIndicator.className = 'loading-indicator active separating';
        break;

      case 'completed':
      case 'cached':
        setStatus('Kütüphaneye kaydedildi', 'completed');
        loadingIndicator.className = 'loading-indicator active completed';

        setTimeout(() => {
          onStemsReady();
          loadingIndicator.className = 'loading-indicator';
        }, 800);
        break;

      case 'error':
        setStatus(data.error || 'Bir hata oluştu', 'error');
        isProcessing = false;
        separateBtn.disabled = false;
        separateBtn.classList.remove('hidden', 'processing');
        cancelBtn.classList.add('hidden');
        btnText.textContent = 'Tekrar Dene';
        loadingIndicator.className = 'loading-indicator';
        break;
    }
  }

  // ─── UI State Transitions ──────────────────────────────────
  function onProcessingStart(status) {
    isProcessing = true;
    separateBtn.classList.add('hidden');
    cancelBtn.classList.remove('hidden');
    loadingIndicator.className = `loading-indicator active ${status}`;
    setStatus('Başlatılıyor...', 'processing');
  }

  function onStemsReady() {
    isProcessing = false;
    stemsReady = true;
    cancelBtn.classList.add('hidden');
    separateBtn.classList.remove('hidden', 'processing');
    separateBtn.classList.add('completed');
    separateBtn.disabled = false;
    if (deleteCacheBtn) deleteCacheBtn.classList.add('hidden');
    btnText.textContent = 'Yeniden Ayrıştır';
    vizOverlay.classList.add('hidden');
    setStatus('', 'ready');

    // Canlı animasyona geç
    stopAnimation();
    startLiveAnimation();
  }

  function resetUI() {
    stemsReady = false;
    isProcessing = false;
    cancelBtn.classList.add('hidden');
    if (deleteCacheBtn) deleteCacheBtn.classList.add('hidden');
    separateBtn.classList.remove('hidden', 'processing', 'completed');
    separateBtn.disabled = false;
    btnText.textContent = 'Ayrıştır';
    vizOverlay.classList.remove('hidden');
    statusText.textContent = '';
    loadingIndicator.className = 'loading-indicator';
    titleText.textContent = 'YouTube\'da bir video açın';

    stopAnimation();
    startIdleAnimation();
  }

  function setStatus(text, type) {
    statusText.textContent = text;
    statusText.className = `status-text status-${type}`;
  }

  // ─── Animation Loops ──────────────────────────────────────
  function startIdleAnimation() {
    stopAnimation();
    function frame() {
      if (visualizer) visualizer.renderIdle();
      animFrame = requestAnimationFrame(frame);
    }
    animFrame = requestAnimationFrame(frame);
  }

  function startLiveAnimation() {
    stopAnimation();
    function frame() {
      if (visualizer) {
        visualizer.updateChannelStates(muted, soloChannel);
        visualizer.render();
      }
      animFrame = requestAnimationFrame(frame);
    }
    animFrame = requestAnimationFrame(frame);
  }

  function stopAnimation() {
    if (animFrame) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }
  }

  // ─── Player Bar Update ─────────────────────────────────────
  function updatePlayerBar(state) {
    if (!state) return;
    currentPlayerState = state;

    currentTimeEl.textContent = formatTime(state.currentTime);
    durationEl.textContent = formatTime(state.duration);
    
    if (playPauseBtn) {
      if (state.state === 1) {
        playPauseBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
      } else {
        playPauseBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
      }
    }

    if (state.duration > 0) {
      const pct = (state.currentTime / state.duration) * 100;
      progressKnob.style.left = `${pct}%`;

      // Her kanalın progress'ini göster (sadece aktif olanlar)
      const segments = ['Vocals', 'Drums', 'Bass', 'Other'];
      segments.forEach(name => {
        const el = document.getElementById(`prog${name}`);
        if (el) {
          const stemName = name.toLowerCase();
          const isActive = !muted[stemName] && (!soloChannel || soloChannel === stemName);
          el.style.width = isActive ? `${pct}%` : '0%';
        }
      });
    }
  }

  // ─── Volume/Mute UI Updates ────────────────────────────────
  function updateSliderUI(stem, value) {
    const fill = document.querySelector(`.slider-fill[data-stem="${stem}"]`);
    if (fill) {
      fill.style.width = `${value}%`;
    }
  }

  function updateMuteUI(stem, isMuted) {
    const btn = document.querySelector(`.mute-btn[data-stem="${stem}"]`);
    const row = document.querySelector(`.channel-row[data-stem="${stem}"]`);
    if (btn) btn.classList.toggle('active', isMuted);
    if (row) row.classList.toggle('muted-visual', isMuted);
    muted[stem] = isMuted;
  }

  function updateSoloUI() {
    STEM_NAMES.forEach(name => {
      const btn = document.querySelector(`.solo-btn[data-stem="${name}"]`);
      if (btn) btn.classList.toggle('active', soloChannel === name);

      // Solo aktifse, solo olmayan kanalları da görsel olarak söndür
      const row = document.querySelector(`.channel-row[data-stem="${name}"]`);
      if (row) {
        if (soloChannel && soloChannel !== name) {
          row.classList.add('muted-visual');
        } else if (!muted[name]) {
          row.classList.remove('muted-visual');
        }
      }
    });
  }

  // ─── Download ──────────────────────────────────────────────
  function downloadStem(stem) {
    const url = `${BACKEND_URL}/api/download/${currentVideoId}/${stem}`;
    // Yeni sekmede aç (indirme tetiklenir)
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentVideoId}_${stem}.wav`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ─── Channel Icons ────────────────────────────────────────
  function drawChannelIcons() {
    const iconConfigs = {
      vocals: (ctx) => {
        ctx.fillStyle = '#d4462e';
        ctx.beginPath();
        ctx.arc(10, 10, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#f4efe6';
        ctx.beginPath();
        ctx.arc(10, 10, 2, 0, Math.PI * 2);
        ctx.fill();
      },
      drums: (ctx) => {
        ctx.fillStyle = '#e8a13c';
        ctx.fillRect(3, 3, 6, 6);
        ctx.fillRect(11, 11, 6, 6);
        ctx.strokeStyle = '#1d1b1a';
        ctx.lineWidth = 1;
        ctx.strokeRect(3, 11, 6, 6);
        ctx.strokeRect(11, 3, 6, 6);
      },
      bass: (ctx) => {
        ctx.strokeStyle = '#2660a4';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(10, 10, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(10, 10, 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#2660a4';
        ctx.beginPath();
        ctx.arc(10, 10, 2, 0, Math.PI * 2);
        ctx.fill();
      },
      other: (ctx) => {
        ctx.strokeStyle = '#1d1b1a';
        ctx.lineWidth = 1.5;
        ctx.lineCap = 'round';
        for (let i = 0; i < 5; i++) {
          const angle = (i / 5) * Math.PI + 0.3;
          ctx.beginPath();
          ctx.moveTo(10 + Math.cos(angle) * 3, 10 + Math.sin(angle) * 3);
          ctx.lineTo(10 + Math.cos(angle) * 8, 10 + Math.sin(angle) * 8);
          ctx.stroke();
        }
      }
    };

    document.querySelectorAll('.channel-icon').forEach(canvas => {
      const shape = canvas.dataset.shape;
      if (iconConfigs[shape]) {
        const ctx = canvas.getContext('2d');
        iconConfigs[shape](ctx);
      }
    });
  }

  // ─── Library ───────────────────────────────────────────────
  async function loadLibrary() {
    try {
      const response = await fetch(`${BACKEND_URL}/api/cache`);
      const data = await response.json();
      
      libraryList.innerHTML = '';
      if (data.count === 0) {
        libraryList.innerHTML = '<div class="library-empty">Henüz ayrıştırılmış şarkı yok.</div>';
        return;
      }

      data.items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'library-item';
        
        const title = document.createElement('span');
        title.className = 'library-item-title';
        title.textContent = item.title || item.video_id;
        title.title = item.title || item.video_id;
        
        const btn = document.createElement('button');
        btn.className = 'library-play-btn';
        btn.textContent = 'Dinle';
        btn.onclick = () => {
          chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${item.video_id}` });
        };
        
        const delBtn = document.createElement('button');
        delBtn.className = 'library-play-btn';
        delBtn.style.background = '#d4462e';
        delBtn.style.marginLeft = '4px';
        delBtn.textContent = 'Sil';
        delBtn.onclick = async () => {
          try {
            if (item.video_id === currentVideoId) {
                resetUI();
                
                await new Promise(resolve => {
                    chrome.tabs.sendMessage(currentTabId, { action: 'restoreYTAudio' }, () => {
                        if (chrome.runtime.lastError) { /* ignore */ }
                        resolve();
                    });
                    setTimeout(resolve, 1000);
                });
                
                setTimeout(async () => {
                    try {
                        await fetch(`${BACKEND_URL}/api/cache/${item.video_id}`, { method: 'DELETE' });
                        loadLibrary();
                    } catch(e) {}
                }, 300);
            } else {
                await fetch(`${BACKEND_URL}/api/cache/${item.video_id}`, { method: 'DELETE' });
                loadLibrary();
            }
          } catch (e) { console.error(e); }
        };

        const folderBtn = document.createElement('button');
        folderBtn.className = 'library-play-btn';
        folderBtn.style.background = '#2660a4';
        folderBtn.style.marginLeft = '4px';
        folderBtn.textContent = 'Klasör';
        folderBtn.onclick = async () => {
          try {
            await fetch(`${BACKEND_URL}/api/open_folder/${item.video_id}`, { method: 'POST' });
          } catch (e) { console.error(e); }
        };
        
        div.appendChild(title);
        div.appendChild(btn);
        div.appendChild(folderBtn);
        div.appendChild(delBtn);
        libraryList.appendChild(div);
      });
    } catch (e) {
      libraryList.innerHTML = '<div class="library-empty">Bağlantı hatası.</div>';
    }
  }

  // ─── Utilities ─────────────────────────────────────────────
  function extractVideoId(url) {
    try {
      const u = new URL(url);
      return u.searchParams.get('v');
    } catch {
      return null;
    }
  }

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ─── Start ─────────────────────────────────────────────────
  init();
})();
