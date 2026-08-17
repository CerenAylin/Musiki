/**
 * Musiki — inject.js
 * YouTube sayfa context'inde çalışan köprü script.
 * YouTube Player API'ye doğrudan erişim sağlar.
 * Content script ile window.postMessage üzerinden haberleşir.
 */
(function () {
  'use strict';

  const POLL_INTERVAL = 50; // ms — senkronizasyon hassasiyeti
  let player = null;
  let pollTimer = null;
  let lastState = -1;
  let lastTime = -1;

  /**
   * YouTube player elementini bul.
   * movie_player bir HTMLElement olup üzerinde
   * getCurrentTime(), getPlayerState() vb. metodlar bulunur.
   */
  function findPlayer() {
    const el = document.getElementById('movie_player');
    if (el && typeof el.getCurrentTime === 'function') {
      return el;
    }
    return null;
  }

  /**
   * Sayfadaki <video> elementini bul (fallback için).
   */
  function findVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  /**
   * Player durumunu content script'e bildir.
   */
  function sendState() {
    // Player veya video elementinden durumu al
    const vid = findVideo();

    if (player) {
      try {
        const currentTime = player.getCurrentTime();
        const state = player.getPlayerState();
        const duration = player.getDuration();

        const stateChanged = state !== lastState;
        const timeJumped = Math.abs(currentTime - lastTime) > 0.3;

        if (stateChanged || timeJumped || state === 1) {
          window.postMessage({
            type: 'MUSIKI_YT_STATE',
            payload: {
              currentTime,
              state,
              duration,
              volume: player.getVolume(),
              isMuted: player.isMuted()
            }
          }, '*');
        }

        lastState = state;
        lastTime = currentTime;
        return;
      } catch (e) {
        // Player hatası — video fallback'e düş
      }
    }

    // Fallback: <video> elementinden durum al
    if (vid) {
      const currentTime = vid.currentTime || 0;
      const duration = vid.duration || 0;
      const state = vid.paused ? 2 : (vid.ended ? 0 : 1);

      const stateChanged = state !== lastState;
      const timeJumped = Math.abs(currentTime - lastTime) > 0.3;

      if (stateChanged || timeJumped || state === 1) {
        window.postMessage({
          type: 'MUSIKI_YT_STATE',
          payload: {
            currentTime,
            state,
            duration,
            volume: Math.round(vid.volume * 100),
            isMuted: vid.muted
          }
        }, '*');
      }

      lastState = state;
      lastTime = currentTime;
    }
  }

  /**
   * Player'ı bul ve polling başlat.
   */
  function init() {
    player = findPlayer();
    if (!player) {
      setTimeout(init, 500);
      return;
    }

    console.log('[Musiki] 🎬 YouTube player bulundu');

    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(sendState, POLL_INTERVAL);

    sendState();
  }

  /**
   * Video oynatma — birden fazla yöntem dene
   */
  function doPlay() {
    console.log('[Musiki] ▶ Play komutu alındı');
    
    // Yöntem 1: Doğrudan <video> elementi (en güvenilir)
    const vid = findVideo();
    if (vid && vid.paused) {
      vid.play().catch(() => {});
    }

    // Yöntem 2: YouTube Player API
    if (player && typeof player.playVideo === 'function') {
      try {
        player.playVideo();
      } catch (e) {}
    }

    // Yöntem 3: YouTube play butonu simülasyonu
    const playBtn = document.querySelector('.ytp-play-button');
    if (playBtn) {
      const ariaLabel = playBtn.getAttribute('aria-label') || '';
      // Sadece "Oynat" veya "Play" durumunda tıkla
      if (ariaLabel.toLowerCase().includes('oynat') || ariaLabel.toLowerCase().includes('play')) {
        playBtn.click();
      }
    }
  }

  /**
   * Video duraklatma — birden fazla yöntem dene
   */
  function doPause() {
    console.log('[Musiki] ⏸ Pause komutu alındı');

    // Yöntem 1: Doğrudan <video> elementi
    const vid = findVideo();
    if (vid && !vid.paused) {
      vid.pause();
    }

    // Yöntem 2: YouTube Player API
    if (player && typeof player.pauseVideo === 'function') {
      try {
        player.pauseVideo();
      } catch (e) {}
    }

    // Yöntem 3: YouTube pause butonu simülasyonu
    const playBtn = document.querySelector('.ytp-play-button');
    if (playBtn) {
      const ariaLabel = playBtn.getAttribute('aria-label') || '';
      if (ariaLabel.toLowerCase().includes('duraklat') || ariaLabel.toLowerCase().includes('pause')) {
        playBtn.click();
      }
    }
  }

  /**
   * Content script'ten gelen komutları dinle.
   */
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'MUSIKI_COMMAND') return;

    // Player'ı lazily bul
    if (!player) player = findPlayer();

    const { action, value } = event.data;

    switch (action) {
      case 'mute':
        if (player && typeof player.mute === 'function') {
          player.mute();
        } else {
          const vid = findVideo();
          if (vid) vid.muted = true;
        }
        console.log('[Musiki] 🔇 YouTube sesi kapatıldı');
        break;

      case 'unmute':
        if (player && typeof player.unMute === 'function') {
          player.unMute();
        } else {
          const vid = findVideo();
          if (vid) vid.muted = false;
        }
        console.log('[Musiki] 🔊 YouTube sesi açıldı');
        break;

      case 'setVolume':
        if (player && typeof player.setVolume === 'function') {
          player.setVolume(value);
        } else {
          const vid = findVideo();
          if (vid) vid.volume = value / 100;
        }
        break;

      case 'seek':
        if (player && typeof player.seekTo === 'function') {
          player.seekTo(value, true);
        } else {
          const vid = findVideo();
          if (vid) vid.currentTime = value;
        }
        break;

      case 'play':
        doPlay();
        break;

      case 'pause':
        doPause();
        break;

      case 'getState':
        sendState();
        break;
    }
  });

  // SPA navigasyon desteği — YouTube sayfa değişimlerini izle
  document.addEventListener('yt-navigate-finish', function () {
    console.log('[Musiki] 🔄 YouTube navigasyon algılandı');
    player = null;
    lastState = -1;
    lastTime = -1;
    setTimeout(init, 300);
  });

  // Başlat
  init();
})();
