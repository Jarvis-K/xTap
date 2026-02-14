// xTap — MAIN world content script
// Monkey-patches window.fetch and XMLHttpRequest to intercept X/Twitter GraphQL API responses.
// Dispatches a CustomEvent to relay data to the ISOLATED world bridge script.
(function () {
  'use strict';

  const GRAPHQL_PATTERN = '/i/api/graphql/';
  // Random event name to avoid detection via document event listeners
  const EVENT_NAME = '_' + Math.random().toString(36).slice(2);
  // Expose the event name to the ISOLATED world via a DOM attribute on a hidden element
  const beacon = document.createElement('meta');
  beacon.name = '__cfg';
  beacon.content = EVENT_NAME;
  (document.head || document.documentElement).appendChild(beacon);

  // Use a WeakMap instead of expando property to avoid detection via Object.keys(xhr)
  const xhrUrls = new WeakMap();

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

  // --- Patch fetch ---
  const originalFetch = window.fetch;
  const patchedFetch = async function fetch(...args) {
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
  // Make toString() return native-looking string to evade detection
  patchedFetch.toString = () => 'function fetch() { [native code] }';
  Object.defineProperty(patchedFetch, 'name', { value: 'fetch' });
  window.fetch = patchedFetch;

  // --- Patch XMLHttpRequest ---
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeOpenStr = nativeOpen.toString();
  const nativeSendStr = nativeSend.toString();

  const patchedOpen = function open(method, url, ...rest) {
    xhrUrls.set(this, (typeof url === 'string') ? url : url?.toString());
    return nativeOpen.call(this, method, url, ...rest);
  };
  patchedOpen.toString = () => nativeOpenStr;

  const patchedSend = function send(...args) {
    const url = xhrUrls.get(this);
    if (url && url.includes(GRAPHQL_PATTERN)) {
      this.addEventListener('load', function () {
        try {
          const data = JSON.parse(this.responseText);
          dispatchData(url, data);
        } catch (_) {}
      });
    }
    return nativeSend.apply(this, args);
  };
  patchedSend.toString = () => nativeSendStr;

  XMLHttpRequest.prototype.open = patchedOpen;
  XMLHttpRequest.prototype.send = patchedSend;
})();
