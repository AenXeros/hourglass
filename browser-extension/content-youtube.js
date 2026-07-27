// Runs on YouTube. Injects a tiny page-context script that reads the current
// video's channel from YouTube's own data, and relays it to the background.
try {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inject.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
} catch (e) {
  /* ignore */
}

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (d && d.source === 'hourglass-yt') {
    try {
      chrome.runtime.sendMessage({
        type: 'yt-context',
        channelName: d.author || '',
        channelHandle: d.handle || '',
        url: location.href,
      });
    } catch (err) {
      /* extension context may be reloading */
    }
  }
});
