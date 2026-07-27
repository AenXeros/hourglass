// Page-context script: reads the current YouTube channel from YouTube's own
// data and posts it back to the content script.
//
// YouTube is a single-page app that leaves window.ytInitialPlayerResponse holding
// the LAST watched video's channel, so we:
//   - only trust it on /watch pages AND only when its videoId matches the URL,
//   - always also read the channel link in the DOM (updates on in-app nav, and
//     reliably carries the @handle even before the name text loads),
//   - on channel pages, read the channel's own metadata + URL handle.
(function () {
  function grab() {
    let author = '';
    let handle = '';
    let channelId = '';
    const onWatch = location.pathname === '/watch';

    if (onWatch) {
      const urlV = new URLSearchParams(location.search).get('v');
      try {
        const pr = window.ytInitialPlayerResponse;
        if (pr && pr.videoDetails && pr.videoDetails.videoId === urlV) {
          author = pr.videoDetails.author || '';
          channelId = pr.videoDetails.channelId || '';
        }
      } catch (e) {
        /* ignore */
      }
      // The channel link under the video — survives SPA navigation and carries
      // the @handle even when the name text hasn't rendered yet.
      try {
        const a = document.querySelector(
          'ytd-video-owner-renderer a.yt-simple-endpoint, #owner ytd-channel-name a, #upload-info ytd-channel-name a'
        );
        if (a) {
          const href = a.getAttribute('href') || '';
          const hm = href.match(/\/@([^/]+)/);
          if (hm) handle = '@' + hm[1];
          const cm = href.match(/\/channel\/(UC[\w-]+)/);
          if (cm && !channelId) channelId = cm[1];
          if (!author) author = (a.textContent || '').trim();
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
      const m = location.pathname.match(/\/@([^/]+)/);
      if (m) handle = '@' + m[1];
      const cm2 = location.pathname.match(/\/channel\/(UC[\w-]+)/);
      if (cm2 && !channelId) channelId = cm2[1];
    }

    window.postMessage({ source: 'hourglass-yt', author, handle, channelId }, '*');
  }

  grab();
  // Re-read on in-app navigation.
  window.addEventListener('yt-navigate-finish', () => setTimeout(grab, 500));
  document.addEventListener('yt-page-data-updated', () => setTimeout(grab, 500));
  // Poll briefly after load/navigation, since these globals and the DOM owner
  // link populate asynchronously.
  let n = 0;
  const iv = setInterval(() => {
    grab();
    if (++n > 10) clearInterval(iv);
  }, 1000);
})();
