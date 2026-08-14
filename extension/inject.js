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
   * Player durumunu content script'e bildir.
   */
  function sendState() {
    if (!player) return;

    try {
      const currentTime = player.getCurrentTime();
      const state = player.getPlayerState();
      const duration = player.getDuration();

      // Sadece değişiklik olduğunda veya playing durumunda gönder
      // (playing durumunda her frame gönderilmeli)
      const stateChanged = state !== lastState;
      const timeJumped = Math.abs(currentTime - lastTime) > 0.3;

      if (stateChanged || timeJumped || state === 1) {
        window.postMessage({
          type: 'MUSIKI_YT_STATE',
          payload: {
            currentTime,
            state,       // -1:unstarted, 0:ended, 1:playing, 2:paused, 3:buffering, 5:cued
            duration,
            volume: player.getVolume(),
            isMuted: player.isMuted()
          }
        }, '*');
      }

      lastState = state;
      lastTime = currentTime;
    } catch (e) {
      // Player henüz hazır olmayabilir
    }
  }

  /**
   * Player'ı bul ve polling başlat.
   */
  function init() {
    player = findPlayer();
    if (!player) {
      // Henüz yüklenmemiş, tekrar dene
      setTimeout(init, 500);
      return;
    }

    console.log('[Musiki] 🎬 YouTube player bulundu');

    // Düzenli polling başlat
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(sendState, POLL_INTERVAL);

    // İlk durumu hemen gönder
    sendState();
  }

  /**
   * Content script'ten gelen komutları dinle.
   */
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== 'MUSIKI_COMMAND') return;

    // Player'ı lazily bul
    if (!player) player = findPlayer();
    if (!player) return;

    const { action, value } = event.data;

    switch (action) {
      case 'mute':
        player.mute();
        console.log('[Musiki] 🔇 YouTube sesi kapatıldı');
        break;

      case 'unmute':
        player.unMute();
        console.log('[Musiki] 🔊 YouTube sesi açıldı');
        break;

      case 'setVolume':
        player.setVolume(value);
        break;

      case 'seek':
        player.seekTo(value, true);
        break;

      case 'play':
        if (player.getPlayerState() !== 1) {
          const playBtn = document.querySelector('.ytp-play-button');
          if (playBtn) playBtn.click();
          else player.playVideo();
        }
        break;

      case 'pause':
        if (player.getPlayerState() === 1) {
          const pauseBtn = document.querySelector('.ytp-play-button');
          if (pauseBtn) pauseBtn.click();
          else player.pauseVideo();
        }
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
