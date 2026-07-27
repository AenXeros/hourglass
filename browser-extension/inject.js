// Page-context script: reads the current YouTube channel from YouTube's own
// globals and posts it back to the content script.
//
// Important: YouTube is a single-page app and leaves window.ytInitialPlayerResponse
// holding the LAST watched video's channel. So we only trust it on /watch pages;
// on channel pages we read the channel's own metadata (and the URL handle).
(function () {
  function grab() {
    let author = '';
    let handle = '';
    let channelId = '';
    const onWatch = location.pathname === '/watch';

    if (onWatch) {
      try {
        const pr = window.ytInitialPlayerResponse;
        if (pr && pr.videoDetails) {
          author = pr.videoDetails.author || '';
          channelId = pr.videoDetails.channelId || '';
        }
      } catch (e) {
        /* ignore */
      }
    } else {
      try {
        const d = window.ytInitialData;
        const cm = d && d.metadata && d.metadata.channelMetadataRenderer;
        if (cm) {
          author = cm.title || '';
          channelId = cm.externalId || '';
        }
      } catch (e) {
        /* ignore */
      }
    }

    const m = location.pathname.match(/\/@([^/]+)/);
    if (m) handle = '@' + m[1];
    const cid = location.pathname.match(/\/channel\/(UC[\w-]+)/);
    if (cid && !channelId) channelId = cid[1];

    window.postMessage({ source: 'hourglass-yt', author, handle, channelId }, '*');
  }

  grab();
  // YouTube is a single-page app — re-read on in-app navigation.
  window.addEventListener('yt-navigate-finish', () => setTimeout(grab, 500));
  document.addEventListener('yt-page-data-updated', () => setTimeout(grab, 500));
  // Poll briefly after load, since the globals populate asynchronously.
  let n = 0;
  const iv = setInterval(() => {
    grab();
    if (++n > 8) clearInterval(iv);
  }, 1200);
})();
