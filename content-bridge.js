// xTap — ISOLATED world bridge script
// Listens for CustomEvents from the MAIN world content script and
// forwards them to the service worker via chrome.runtime.sendMessage().
(function () {
  'use strict';

  const EVENT_NAME = '__xtap_graphql';

  document.addEventListener(EVENT_NAME, (e) => {
    try {
      const payload = JSON.parse(e.detail);
      chrome.runtime.sendMessage({
        type: 'GRAPHQL_RESPONSE',
        url: payload.url,
        endpoint: payload.endpoint,
        data: payload.data
      });
    } catch (_) {
      // Silently ignore parse errors
    }
  });
})();
