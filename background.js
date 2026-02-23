// xTap — Service Worker (background)
import { extractTweets } from './lib/tweet-parser.js';

const NATIVE_HOST = 'com.xtap.host';
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 30_000;
const MAX_SEEN_IDS = 50_000;
const HTTP_TIMEOUT_MS = 10_000;
const TOKEN_BOOTSTRAP_TIMEOUT_MS = 5_000;
const BOOTSTRAP_BACKOFF_BASE_MS = 2_000;
const BOOTSTRAP_BACKOFF_MAX_MS = 300_000;
const HTTP_RECOVERY_TICK_MS = 30_000;

let captureEnabled = true;
let buffer = [];
let flushTimer = null;
let seenIds = new Set();
let sessionCount = 0;
let allTimeCount = 0;
let outputDir = '';
let debugLogging = false;
let verboseLogging = false;
let allowNativeFallback = true;
let logBuffer = [];
let readyResolve;
const ready = new Promise(r => { readyResolve = r; });

// --- Recent tweets cache (for video download lookup) ---
const MAX_RECENT_TWEETS = 1000;
const recentTweets = new Map();
// tweetId → downloadId for in-progress downloads (so popup can resume polling)
const activeDownloads = new Map();

// --- Transport state ---
// 'http' | 'native' | 'none'
let transport = 'none';
// 'http_ready' | 'http_degraded' | 'native_fallback' | 'no_transport'
let transportState = 'no_transport';
let httpToken = null;
let httpPort = null;
let bootstrapTimer = null;
let bootstrapAttempt = 0;
let bootstrapInFlight = false;
let recoveryTimer = null;

// --- State persistence ---

async function saveState() {
  await chrome.storage.local.set({
    seenIds: [...seenIds].slice(-MAX_SEEN_IDS),
    allTimeCount,
    captureEnabled
  });
}

async function restoreState() {
  const stored = await chrome.storage.local.get(['seenIds', 'allTimeCount', 'captureEnabled', 'outputDir', 'debugLogging', 'verboseLogging', 'allowNativeFallback']);
  if (stored.seenIds) seenIds = new Set(stored.seenIds);
  if (typeof stored.allTimeCount === 'number') allTimeCount = stored.allTimeCount;
  if (typeof stored.captureEnabled === 'boolean') captureEnabled = stored.captureEnabled;
  if (typeof stored.outputDir === 'string') outputDir = stored.outputDir;
  if (typeof stored.debugLogging === 'boolean') debugLogging = stored.debugLogging;
  if (typeof stored.verboseLogging === 'boolean') verboseLogging = stored.verboseLogging;
  if (typeof stored.allowNativeFallback === 'boolean') allowNativeFallback = stored.allowNativeFallback;
}

// --- Debug logging ---

const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;

function debugLog(level, args) {
  if (!debugLogging) return;
  const ts = new Date().toISOString();
  const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  logBuffer.push(`${ts} [${level}] ${text}`);
}

console.log = (...args) => { _origLog(...args); debugLog('LOG', args); };
console.warn = (...args) => { _origWarn(...args); debugLog('WARN', args); };
console.error = (...args) => { _origError(...args); debugLog('ERROR', args); };

// --- HTTP transport ---

async function httpFetch(method, path, body) {
  const url = `http://127.0.0.1:${httpPort}${path}`;
  const opts = { method, headers: {} };
  if (httpToken) {
    opts.headers['Authorization'] = `Bearer ${httpToken}`;
  }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  opts.signal = controller.signal;
  try {
    const resp = await fetch(url, opts);
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function probeHttp(port, token) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(3000)
    });
    const data = await resp.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

async function getTokenViaDaemon(port = 17381) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/bootstrap-token`, {
      signal: AbortSignal.timeout(3000)
    });
    const data = await resp.json();
    if (data?.ok && data?.token && data?.port) {
      return { token: data.token, port: data.port };
    }
    return null;
  } catch {
    return null;
  }
}

async function getTokenViaNative() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        // no-op
      }
      resolve(result);
    };

    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      finish(null);
    }, TOKEN_BOOTSTRAP_TIMEOUT_MS);
    port.onMessage.addListener((msg) => {
      if (msg.ok && msg.token) {
        finish({ token: msg.token, port: msg.port });
      } else {
        finish(null);
      }
    });
    port.onDisconnect.addListener(() => {
      finish(null);
    });
    try {
      port.postMessage({ type: 'GET_TOKEN' });
    } catch {
      finish(null);
    }
  });
}

function setTransport(mode, state, reason) {
  const changed = transport !== mode || transportState !== state;
  transport = mode;
  transportState = state;
  if (!changed) return;
  if (reason) {
    console.log(`[xTap] Transport -> ${state} (${mode}) | ${reason}`);
  } else {
    console.log(`[xTap] Transport -> ${state} (${mode})`);
  }
}

function scheduleBootstrap(delayMs = 0, reason = '') {
  if (transport === 'http' || bootstrapInFlight || bootstrapTimer) return;
  bootstrapTimer = setTimeout(() => {
    bootstrapTimer = null;
    bootstrapHttpToken(reason);
  }, Math.max(0, delayMs));
}

function startRecoveryLoop() {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(() => {
    if (transport !== 'http') {
      scheduleBootstrap(0, 'periodic recovery tick');
    }
  }, HTTP_RECOVERY_TICK_MS);
}

function bootstrapBackoffMs(attempt) {
  const base = Math.min(BOOTSTRAP_BACKOFF_MAX_MS, BOOTSTRAP_BACKOFF_BASE_MS * (2 ** Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * base * 0.3);
  return base + jitter;
}

async function bootstrapHttpToken(reason = '') {
  if (transport === 'http' || bootstrapInFlight) return;
  bootstrapInFlight = true;
  bootstrapAttempt += 1;
  try {
    let result = await getTokenViaDaemon(httpPort || 17381);
    let source = 'daemon';
    if (!result) {
      result = await getTokenViaNative();
      source = 'native';
    }

    if (result) {
      const alive = await probeHttp(result.port, result.token);
      if (alive) {
        httpToken = result.token;
        httpPort = result.port;
        await chrome.storage.local.set({ httpToken, httpPort });
        bootstrapAttempt = 0;
        setTransport('http', 'http_ready', reason || 'token bootstrap succeeded');
        console.log(`[xTap] Using HTTP transport (token from ${source})`);
        return;
      }
    }

    const delay = bootstrapBackoffMs(bootstrapAttempt);
    setTransport('none', 'http_degraded', reason || 'token bootstrap failed');
    console.warn(`[xTap] HTTP token bootstrap retry #${bootstrapAttempt} in ${delay}ms`);
    scheduleBootstrap(delay, 'retry after bootstrap failure');
  } finally {
    bootstrapInFlight = false;
  }
}

async function initTransport() {
  // Fast path: cached token + daemon health check.
  const cached = await chrome.storage.local.get(['httpToken', 'httpPort']);
  if (cached.httpToken && cached.httpPort) {
    const alive = await probeHttp(cached.httpPort, cached.httpToken);
    if (alive) {
      httpToken = cached.httpToken;
      httpPort = cached.httpPort;
      setTransport('http', 'http_ready', 'cached token accepted');
      console.log('[xTap] Using HTTP transport (cached token)');
      return;
    }
  }

  // Prefer daemon bootstrap over native startup path.
  const daemonToken = await getTokenViaDaemon(httpPort || 17381);
  if (daemonToken) {
    const alive = await probeHttp(daemonToken.port, daemonToken.token);
    if (alive) {
      httpToken = daemonToken.token;
      httpPort = daemonToken.port;
      await chrome.storage.local.set({ httpToken, httpPort });
      setTransport('http', 'http_ready', 'token from daemon bootstrap');
      console.log('[xTap] Using HTTP transport (token from daemon)');
      return;
    }
  }

  // Degraded start: keep capture alive, bootstrap token in background.
  setTransport('none', 'http_degraded', 'cached token unavailable or daemon not reachable');
  scheduleBootstrap(0, 'initial bootstrap');
}

// --- Native messaging ---

async function sendViaNative(msg, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    let port;
    let settled = false;

    const cleanup = () => {
      try {
        port.onMessage.removeListener(onMessage);
      } catch {
        // no-op
      }
      try {
        port.onDisconnect.removeListener(onDisconnect);
      } catch {
        // no-op
      }
      try {
        port.disconnect();
      } catch {
        // no-op
      }
    };

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (err) reject(err);
      else resolve(value);
    };

    const onMessage = (nativeResp) => finish(null, nativeResp);
    const onDisconnect = () => {
      const err = chrome.runtime.lastError?.message;
      if (err) finish(new Error(err));
      else finish(null, null);
    };

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      reject(e);
      return;
    }

    const timer = setTimeout(() => finish(new Error('Native host timeout')), timeoutMs);

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);

    try {
      port.postMessage(msg);
    } catch (e) {
      finish(e);
    }
  });
}

function supportsNativeFallback(msg) {
  if (!msg.type) return true; // tweet batch
  return msg.type === 'LOG' || msg.type === 'DUMP' || msg.type === 'TEST_PATH';
}

function httpRouteFor(msg) {
  if (msg.type === 'TEST_PATH') {
    return { path: '/test-path', body: { outputDir: msg.outputDir } };
  }
  if (msg.type === 'LOG') {
    const body = { lines: msg.lines };
    if (msg.outputDir) body.outputDir = msg.outputDir;
    return { path: '/log', body };
  }
  if (msg.type === 'DUMP') {
    const body = { filename: msg.filename, content: msg.content };
    if (msg.outputDir) body.outputDir = msg.outputDir;
    return { path: '/dump', body };
  }
  if (msg.type === 'CHECK_YTDLP') {
    return { path: '/check-ytdlp', body: {} };
  }
  if (msg.type === 'DOWNLOAD_VIDEO') {
    const body = { tweetUrl: msg.tweetUrl, directUrl: msg.directUrl, postDate: msg.postDate };
    if (msg.outputDir) body.outputDir = msg.outputDir;
    return { path: '/download-video', body };
  }
  if (msg.type === 'DOWNLOAD_STATUS') {
    return { path: '/download-status', body: { downloadId: msg.downloadId } };
  }
  const body = { tweets: msg.tweets };
  if (msg.outputDir) body.outputDir = msg.outputDir;
  return { path: '/tweets', body };
}

// --- Unified send ---

async function sendToHost(msg) {
  if (httpToken && httpPort) {
    try {
      const { path, body } = httpRouteFor(msg);
      const resp = await httpFetch('POST', path, body);
      if (transport !== 'http') {
        setTransport('http', 'http_ready', 'HTTP request succeeded');
      }
      return resp;
    } catch (e) {
      setTransport('none', 'http_degraded', `HTTP send failed: ${e.message}`);
      scheduleBootstrap(0, 'HTTP send failure');
    }
  }

  if (supportsNativeFallback(msg)) {
    if (!allowNativeFallback) {
      setTransport('none', 'http_degraded', 'native fallback disabled by user');
      scheduleBootstrap(0, 'native fallback disabled');
      return null;
    }
    try {
      const resp = await sendViaNative(msg);
      setTransport('native', 'native_fallback', 'using on-demand native fallback');
      scheduleBootstrap(0, 'attempt return to HTTP after native fallback');
      return resp;
    } catch (e) {
      setTransport('none', 'no_transport', `native fallback failed: ${e.message}`);
      console.warn('[xTap] Native fallback unavailable:', e.message);
      return null;
    }
  }

  if (transport !== 'http') {
    setTransport('none', 'http_degraded', 'HTTP daemon unavailable for this operation');
    scheduleBootstrap(0, 'operation requires HTTP transport');
  }
  console.warn('[xTap] No transport available for this operation');
  return null;
}

// --- Batching & flushing ---

function scheduledFlush() {
  if (buffer.length > 0 || logBuffer.length > 0) flush();
}

async function flushLogs() {
  if (logBuffer.length === 0) return;
  const lines = logBuffer.splice(0);
  const message = { type: 'LOG', lines };
  if (outputDir) message.outputDir = outputDir;
  await sendToHost(message);
}

async function flush() {
  if (buffer.length === 0 && logBuffer.length === 0) return;

  if (buffer.length > 0) {
    const batch = buffer.splice(0);
    const message = { tweets: batch };
    if (outputDir) message.outputDir = outputDir;

    try {
      const resp = await sendToHost(message);
      if (resp && !resp.ok) {
        console.error('[xTap] Host rejected tweets:', resp.error);
      }
    } catch (e) {
      console.error('[xTap] Send failed, buffering tweets back:', e);
      buffer.unshift(...batch);
    }
  }

  if (debugLogging) await flushLogs();
}

function enqueueTweets(tweets) {
  let newCount = 0;
  for (const tweet of tweets) {
    // Always cache for video lookup (even dupes — updates with latest data)
    if (tweet.id) {
      recentTweets.set(tweet.id, tweet);
      // FIFO eviction
      if (recentTweets.size > MAX_RECENT_TWEETS) {
        const oldest = recentTweets.keys().next().value;
        recentTweets.delete(oldest);
      }
    }

    // Article tweets bypass dedup — they enrich a previously captured stub
    if (seenIds.has(tweet.id) && !tweet.is_article) continue;
    seenIds.add(tweet.id);
    buffer.push(tweet);
    newCount++;
  }

  // FIFO eviction if seenIds grows too large
  if (seenIds.size > MAX_SEEN_IDS) {
    const arr = [...seenIds];
    seenIds = new Set(arr.slice(arr.length - MAX_SEEN_IDS));
  }

  const dupeCount = tweets.length - newCount;
  if (dupeCount > 0) {
    console.log(`[xTap] Dedup: ${newCount} new, ${dupeCount} duplicates skipped (seenIds: ${seenIds.size})`);
  }

  sessionCount += newCount;
  allTimeCount += newCount;
  updateBadge();
  saveState();

  if (buffer.length >= BATCH_SIZE) flush();
}

// --- Badge ---

function updateBadge() {
  const text = sessionCount > 0 ? String(sessionCount) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#1D9BF0' });
}

// --- Verbose logging (discovery mode) ---

function summarizeShape(obj, depth = 0, maxDepth = 3) {
  if (depth >= maxDepth) return typeof obj === 'object' && obj !== null ? (Array.isArray(obj) ? '[…]' : '{…}') : typeof obj;
  if (obj === null) return 'null';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return `[${obj.length}× ${summarizeShape(obj[0], depth + 1, maxDepth)}]`;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    const entries = keys.slice(0, 12).map(k => `${k}: ${summarizeShape(obj[k], depth + 1, maxDepth)}`);
    if (keys.length > 12) entries.push(`…+${keys.length - 12} more`);
    return `{ ${entries.join(', ')} }`;
  }
  if (typeof obj === 'string') return obj.length > 80 ? `str(${obj.length})` : JSON.stringify(obj);
  return String(obj);
}

function verboseLog(endpoint, data) {
  if (!verboseLogging) return;
  const shape = summarizeShape(data);
  console.log(`[xTap:verbose] ${endpoint} response shape: ${shape}`);

  // Dump full JSON to file for reverse engineering.
  // Configure via console:
  //   chrome.storage.local.set({verboseDumpIds: ['1234567890']})   — dump responses containing these IDs
  //   chrome.storage.local.set({verboseDumpEndpoint: 'TweetDetail'}) — dump all responses for this endpoint
  // Dumps are written to <outputDir>/dump-<endpoint>-<timestamp>.json
  chrome.storage.local.get(['verboseDumpIds', 'verboseDumpEndpoint'], (cfg) => {
    let shouldDump = false;
    let reason = '';

    if (cfg.verboseDumpEndpoint === endpoint) {
      shouldDump = true;
      reason = `endpoint=${endpoint}`;
    }
    if (!shouldDump && cfg.verboseDumpIds?.length) {
      const json = JSON.stringify(data);
      for (const id of cfg.verboseDumpIds) {
        if (json.includes(id)) {
          shouldDump = true;
          reason = `id=${id}`;
          break;
        }
      }
    }

    if (shouldDump) {
      const ts = Date.now();
      const filename = `dump-${endpoint}-${ts}.json`;
      const content = JSON.stringify(data, null, 2);
      sendToHost({ type: 'DUMP', filename, content, outputDir: outputDir || undefined });
      console.log(`[xTap:dump] ${endpoint} (${reason}) → ${filename} (${content.length} chars)`);
    }
  });
}

// --- Message handling ---

// Endpoints that use /i/api/graphql/ but never contain tweets
const IGNORED_ENDPOINTS = new Set([
  'DataSaverMode', 'getAltTextPromptPreference', 'useDirectCallSetupQuery',
  'XChatDmSettingsQuery', 'useTotalAdCampaignsForUserQuery', 'useStoryTopicQuery',
  'useSubscriptionsPaymentFailureQuery', 'PinnedTimelines', 'ExploreSidebar',
  'SidebarUserRecommendations', 'useFetchProductSubscriptionsQuery',
  'ExplorePage', 'UserByScreenName',
  'ProfileSpotlightsQuery', 'useFetchProfileSections_canViewExpandedProfileQuery',
  'UserSuperFollowTweets', 'NotificationsTimeline', 'AuthenticatePeriscope',
  'BookmarkFoldersSlice', 'EditBookmarkFolder', 'fetchPostQuery',
  'useReadableMessagesSnapshotMutation', 'UsersByRestIds',
]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GRAPHQL_RESPONSE') {
    (async () => {
      await ready;
      verboseLog(msg.endpoint, msg.data);
      if (!captureEnabled) return;
      if (IGNORED_ENDPOINTS.has(msg.endpoint)) {
        if (verboseLogging) console.log(`[xTap:verbose] ${msg.endpoint} (ignored)`);
        return;
      }
      try {
        const tweets = extractTweets(msg.endpoint, msg.data);
        for (const t of tweets) t.source_endpoint = msg.endpoint;
        if (tweets.length > 0) {
          const missingAuthor = tweets.filter(t => !t.author?.username).length;
          const missingText = tweets.filter(t => !t.text).length;
          let warn = '';
          if (missingAuthor > 0) warn += ` | ${missingAuthor} missing username`;
          if (missingText > 0) warn += ` | ${missingText} missing text`;
          console.log(`[xTap] ${msg.endpoint}: ${tweets.length} tweets${warn}`);
          enqueueTweets(tweets);
        }
      } catch (e) {
        console.error(`[xTap] Parse error for ${msg.endpoint}:`, e, '| data keys:', Object.keys(msg.data || {}).join(', '));
      }
    })();
    return;
  }

  if (msg.type === 'GET_STATUS') {
    (async () => {
      await ready;
      sendResponse({
        captureEnabled,
        sessionCount,
        allTimeCount,
        connected: transport !== 'none',
        buffered: buffer.length,
        outputDir,
        debugLogging,
        verboseLogging,
        transport,
        transportState,
        allowNativeFallback
      });
    })();
    return true;
  }

  if (msg.type === 'SET_DEBUG') {
    debugLogging = !!msg.debugLogging;
    chrome.storage.local.set({ debugLogging });
    if (debugLogging) {
      console.log('[xTap] Debug logging enabled');
    } else {
      logBuffer = [];
    }
    sendResponse({ debugLogging });
    return true;
  }

  if (msg.type === 'SET_VERBOSE') {
    verboseLogging = !!msg.verboseLogging;
    chrome.storage.local.set({ verboseLogging });
    console.log(`[xTap] Verbose logging ${verboseLogging ? 'enabled' : 'disabled'}`);
    sendResponse({ verboseLogging });
    return true;
  }

  if (msg.type === 'SET_TRANSPORT_PREFS') {
    if (typeof msg.allowNativeFallback === 'boolean') {
      allowNativeFallback = msg.allowNativeFallback;
      chrome.storage.local.set({ allowNativeFallback });
      if (!allowNativeFallback && transport === 'native') {
        setTransport('none', 'http_degraded', 'native fallback disabled by user');
      }
    }
    sendResponse({ ok: true, allowNativeFallback });
    return true;
  }

  if (msg.type === 'FORCE_HTTP_RETRY') {
    scheduleBootstrap(0, 'manual retry');
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'SET_OUTPUT_DIR') {
    const newDir = msg.outputDir || '';
    if (newDir) {
      sendToHost({ type: 'TEST_PATH', outputDir: newDir }).then((resp) => {
        if (resp && resp.ok) {
          outputDir = newDir;
          chrome.storage.local.set({ outputDir });
          sendResponse({ outputDir });
        } else {
          sendResponse({ error: resp?.error || 'Cannot write to that directory' });
        }
      }).catch((e) => {
        sendResponse({ error: e.message });
      });
    } else {
      outputDir = newDir;
      chrome.storage.local.set({ outputDir });
      sendResponse({ outputDir });
    }
    return true;
  }

  if (msg.type === 'TOGGLE_CAPTURE') {
    captureEnabled = !captureEnabled;
    saveState();
    sendResponse({ captureEnabled });
    return true;
  }

  if (msg.type === 'CHECK_VIDEO') {
    const tweet = recentTweets.get(msg.tweetId);
    if (!tweet || !tweet.media || tweet.media.length === 0) {
      sendResponse({ hasVideo: false });
      return true;
    }
    const videoMedia = tweet.media.find(m => m.type === 'video' || m.type === 'animated_gif');
    if (!videoMedia) {
      sendResponse({ hasVideo: false });
      return true;
    }
    sendResponse({
      hasVideo: true,
      tweetUrl: tweet.url || `https://x.com/i/status/${msg.tweetId}`,
      directUrl: videoMedia.url || null,
      mediaType: videoMedia.type,
      durationMs: videoMedia.duration_ms || null,
      postDate: tweet.created_at || null,
      activeDownloadId: activeDownloads.get(msg.tweetId) || null,
    });
    return true;
  }

  if (msg.type === 'CHECK_YTDLP') {
    (async () => {
      try {
        const resp = await sendToHost({ type: 'CHECK_YTDLP' });
        sendResponse(resp || { ok: false, error: 'No transport' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'DOWNLOAD_VIDEO') {
    (async () => {
      try {
        const resp = await sendToHost({
          type: 'DOWNLOAD_VIDEO',
          tweetUrl: msg.tweetUrl,
          directUrl: msg.directUrl,
          postDate: msg.postDate,
          outputDir: outputDir || undefined,
        });
        // Track active download so popup can resume polling after close/reopen
        if (resp?.ok && resp.downloadId && msg.tweetId) {
          activeDownloads.set(msg.tweetId, resp.downloadId);
        }
        sendResponse(resp || { ok: false, error: 'No transport' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'DOWNLOAD_STATUS') {
    (async () => {
      try {
        const resp = await sendToHost({
          type: 'DOWNLOAD_STATUS',
          downloadId: msg.downloadId,
        });
        // Clean up finished downloads from active map
        if (resp?.status === 'done' || resp?.status === 'error') {
          for (const [tid, did] of activeDownloads) {
            if (did === msg.downloadId) { activeDownloads.delete(tid); break; }
          }
        }
        sendResponse(resp || { ok: false, error: 'No transport' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});

// --- Init ---

restoreState().then(async () => {
  readyResolve();
  updateBadge();
  await initTransport();
  startRecoveryLoop();
  function scheduleNextFlush() {
    const jitter = Math.random() * FLUSH_INTERVAL_MS * 0.5;
    flushTimer = setTimeout(() => { scheduledFlush(); scheduleNextFlush(); }, FLUSH_INTERVAL_MS + jitter);
  }
  scheduleNextFlush();
  console.log('[xTap] Service worker started');
});
