/**
 * Musiki — background.js (Service Worker)
 * Popup ↔ Content Script ↔ Backend arasında köprü görevi görür.
 * Separation API çağrılarını yönetir.
 */

const BACKEND_URL = 'http://localhost:8765';
const POLL_INTERVAL = 1500; // ms

// Tab bazlı processing state
const tabState = {};

// ─── Message Handler ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  switch (msg.action) {

    case 'startSeparation': {
      const { videoId, tabId } = msg;
      handleSeparation(videoId, tabId);
      sendResponse({ status: 'started' });
      break;
    }

    case 'checkBackend': {
      checkBackendHealth()
        .then(data => sendResponse({ online: true, ...data }))
        .catch(() => sendResponse({ online: false }));
      return true; // async response
    }

    case 'getTabState': {
      const { tabId } = msg;
      sendResponse(tabState[tabId] || null);
      break;
    }

    case 'checkStatus': {
      const { videoId } = msg;
      checkStatus(videoId)
        .then(data => sendResponse(data))
        .catch(err => sendResponse({ status: 'error', error: err.message }));
      return true;
    }
  }
});

// ─── Separation Flow ─────────────────────────────────────────────
async function handleSeparation(videoId, tabId) {
  try {
    tabState[tabId] = {
      videoId,
      status: 'starting',
      title: null,
      stems: null,
      error: null
    };

    broadcastStatus(tabId);

    // POST /api/separate
    const response = await fetch(`${BACKEND_URL}/api/separate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId })
    });

    if (!response.ok) {
      throw new Error(`Backend hatası: ${response.status}`);
    }

    const data = await response.json();

    if (data.status === 'cached' || data.status === 'completed') {
      // Zaten hazır!
      onSeparationComplete(tabId, data);
      return;
    }

    // İşlem başladı, polling başlat
    tabState[tabId].status = data.status || 'processing';
    tabState[tabId].title = data.title;
    broadcastStatus(tabId);

    pollStatus(tabId, videoId);

  } catch (err) {
    console.error('[Musiki BG] Separation hatası:', err);
    tabState[tabId] = {
      videoId,
      status: 'error',
      title: null,
      stems: null,
      error: err.message
    };
    broadcastStatus(tabId);
  }
}

// ─── Status Polling ──────────────────────────────────────────────
function pollStatus(tabId, videoId) {
  const intervalId = setInterval(async () => {
    try {
      const data = await checkStatus(videoId);

      tabState[tabId] = {
        videoId,
        status: data.status,
        title: data.title,
        stems: data.stems,
        error: data.error
      };

      broadcastStatus(tabId);

      if (data.status === 'completed' || data.status === 'cached') {
        clearInterval(intervalId);
        onSeparationComplete(tabId, data);
      } else if (data.status === 'error') {
        clearInterval(intervalId);
      }
    } catch (e) {
      console.error('[Musiki BG] Polling hatası:', e);
      // Devam et, sunucu geçici olarak erişilemez olabilir
    }
  }, POLL_INTERVAL);

  // 10 dakika sonra polling'i durdur (güvenlik)
  setTimeout(() => clearInterval(intervalId), 10 * 60 * 1000);
}

// ─── On Complete ─────────────────────────────────────────────────
function onSeparationComplete(tabId, data) {
  console.log('[Musiki BG] ✅ Separation tamamlandı:', data.title);

  tabState[tabId] = {
    videoId: data.video_id,
    status: 'completed',
    title: data.title,
    duration: data.duration,
    stems: data.stems,
    error: null
  };

  // Content script'e stem'leri yükle komutu gönder
  chrome.tabs.sendMessage(tabId, {
    action: 'loadStems',
    stems: data.stems,
    title: data.title
  }).catch(err => {
    console.error('[Musiki BG] Content script\'e mesaj gönderilemedi:', err);
  });

  broadcastStatus(tabId);
}

// ─── Helpers ─────────────────────────────────────────────────────
async function checkStatus(videoId) {
  const response = await fetch(`${BACKEND_URL}/api/status/${videoId}`);
  if (!response.ok) throw new Error(`Status hatası: ${response.status}`);
  return await response.json();
}

async function checkBackendHealth() {
  const response = await fetch(`${BACKEND_URL}/api/health`);
  if (!response.ok) throw new Error('Backend erişilemez');
  return await response.json();
}

function broadcastStatus(tabId) {
  // Popup'a durum güncellemesi gönder (açıksa)
  chrome.runtime.sendMessage({
    action: 'statusUpdate',
    tabId,
    ...tabState[tabId]
  }).catch(() => {
    // Popup kapalı olabilir, sorun değil
  });
}
