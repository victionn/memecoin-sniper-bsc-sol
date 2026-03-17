// Uxento Injector — Background (MV3 service worker)

const STATE = {
  DEBUG: true,
  version: '1.3.0',
  lastPingAt: 0
};

function log(...args) {
  if (!STATE.DEBUG) return;
  console.log('[UxentoInjector/bg]', ...args);
}

chrome.runtime.onInstalled.addListener(() => {
  log('onInstalled', STATE.version);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) {
        sendResponse({ ok:false, error:'No message type' });
        return;
      }

      if (msg.type === 'bg.ping') {
        STATE.lastPingAt = Date.now();
        sendResponse({ ok:true, now: STATE.lastPingAt, version: STATE.version });
        return;
      }

      if (msg.type === 'bg.setDebug') {
        STATE.DEBUG = !!msg.enable;
        sendResponse({ ok:true, DEBUG: STATE.DEBUG });
        return;
      }

      if (msg.type === 'content.inject' || msg.type === 'content.ping' || msg.type === 'content.hud' || msg.type === 'content.setDebug') {
        const res = await sendToActiveTab(msg.type, msg.payload || {});
        sendResponse(res);
        return;
      }

      sendResponse({ ok:false, error:`Unknown bg message: ${msg.type}` });
    } catch (e) {
      log('Error handling message', e);
      sendResponse({ ok:false, error: String(e) });
    }
  })();
  return true; // async
});

async function getActiveUxentoTab() {
  const tabs = await chrome.tabs.query({ active:true, currentWindow:true });
  const tab = tabs[0];
  if (!tab || !tab.id) throw new Error('No active tab');
  return tab.id;
}

async function sendToActiveTab(type, payload) {
  const tabId = await getActiveUxentoTab();
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type, payload });
    return res || { ok:true, via:'bg' };
  } catch (e) {
    log('sendTabs error', e);
    return { ok:false, error: 'Failed to reach content. Is the page matched and content script loaded?' };
  }
}
