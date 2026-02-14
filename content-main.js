// xTap — MAIN world content script
// Monkey-patches window.fetch and XMLHttpRequest to intercept X/Twitter GraphQL API responses.
// Dispatches a CustomEvent to relay data to the ISOLATED world bridge script.
(function () {
  'use strict';

  const GRAPHQL_PATTERN = '/i/api/graphql/';
  const EVENT_NAME = '__xtap_graphql';

  function extractEndpoint(url) {
    try {
      const path = new URL(url, location.origin).pathname;
      const parts = path.split('/');
      const gqlIdx = parts.indexOf('graphql');
      return (gqlIdx >= 0 && parts[gqlIdx + 2]) ? parts[gqlIdx + 2] : 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  function dispatchData(url, data) {
    const endpoint = extractEndpoint(url);
    document.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: JSON.stringify({ url, endpoint, data })
    }));
  }

  // --- Patch fetch (in case some calls use it) ---
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url;
      if (url && url.includes(GRAPHQL_PATTERN)) {
        const clone = response.clone();
        clone.json().then(data => dispatchData(url, data)).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  // --- Patch XMLHttpRequest ---
  const XHROpen = XMLHttpRequest.prototype.open;
  const XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._xtapUrl = (typeof url === 'string') ? url : url?.toString();
    return XHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._xtapUrl && this._xtapUrl.includes(GRAPHQL_PATTERN)) {
      this.addEventListener('load', function () {
        try {
          const data = JSON.parse(this.responseText);
          dispatchData(this._xtapUrl, data);
        } catch (_) {}
      });
    }
    return XHRSend.apply(this, args);
  };

  console.log('[xTap] Content script loaded — fetch + XHR patched');
})();
