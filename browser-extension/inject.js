// Page-context script: reads the current YouTube channel from YouTube's own
// globals (robust across their DOM changes) and posts it back to the content
// script. Covers watch pages (video author) and channel pages (URL handle /
// channel metadata).
(function () {
  function grab() {
    let author = '';
    let handle = '';
    let channelId = '';
    try {
      const pr = window.ytInitialPlayerResponse;
      if (pr && pr.videoDetails) {
        author = pr.videoDetails.author || '';
        channelId = pr.videoDetails.channelId || '';
      }
    } catch (e) {
      /* ignore */
    }
    if (!author) {
      try {
        const d = window.ytInitialData;
        const cm = d && d.metadata && d.metadata.channelMetadataRenderer;
        if (cm) author = cm.title || '';
      } catch (e) {
        /* ignore */
      }
    }
    const m = location.pathname.match(/\/@([^/]+)/);
    if (m) handle = '@' + m[1];
    window.postMessage({ source: 'hourglass-yt', author, handle, channelId }, '*');
  }

  grab();
  // YouTube is a single-page app — re-read on in-app navigation.
  window.addEventListener('yt-navigate-finish', () => setTimeout(grab, 500));
  document.addEventListener('yt-page-data-updated', () => setTimeout(grab, 500));
  // Also poll briefly after load, since the globals populate asynchronously.
  let n = 0;
  const iv = setInterval(() => {
    grab();
    if (++n > 8) clearInterval(iv);
  }, 1200);
})();
