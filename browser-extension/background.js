// Hourglass Connector — reports the active tab's site (and, for YouTube, the
// channel) to the local Hourglass app so it can auto-switch timers.
const APP = 'http://127.0.0.1:45871';
const ytByTab = {}; // tabId -> { channelName, channelHandle, url }

function siteOf(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtu.be') return 'youtube';
    if (h === 'instagram.com' || h.endsWith('.instagram.com')) return 'instagram';
    if (h === 'quran.com' || h.endsWith('.quran.com')) return 'quran';
    return 'other';
  } catch {
    return 'other';
  }
}

function post(payload) {
  fetch(APP + '/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

async function report() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url) {
      post({ site: 'other' });
      return;
    }
    const site = siteOf(tab.url);
    const payload = { site, url: tab.url };
    if (site === 'youtube') payload.youtube = ytByTab[tab.id] || {};
    post(payload);
  } catch {
    /* ignore */
  }
}

chrome.tabs.onActivated.addListener(() => report());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' || info.url) report();
});
chrome.windows.onFocusChanged.addListener((w) => {
  if (w === chrome.windows.WINDOW_ID_NONE) post({ site: 'other' });
  else report();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  delete ytByTab[tabId];
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'yt-context' && sender.tab) {
    ytByTab[sender.tab.id] = {
      channelName: msg.channelName,
      channelHandle: msg.channelHandle,
      channelId: msg.channelId,
      url: msg.url,
    };
    report();
  }
});

// Heartbeat keeps the service worker alive and the app's "connected" badge lit.
chrome.alarms.create('hourglass-hb', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'hourglass-hb') {
    fetch(APP + '/ping').catch(() => {});
    report();
  }
});

report();
