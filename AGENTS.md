# AGENTS.md - xTap

## What This Is

xTap is a Chrome extension that passively captures tweets from X/Twitter by intercepting GraphQL API responses the browser already receives. No scraping, no extra requests — just structured JSONL output of what the user sees.

**Repo:** github.com/mkubicek/xTap
**License:** MIT (public repo)

## Architecture

```
content-main.js (MAIN world)
  │  Patches fetch() + XHR.open() to intercept GraphQL responses
  │  Emits CustomEvent with random per-page name
  ▼
content-bridge.js (ISOLATED world)
  │  Reads event name from <meta> tag, listens, relays
  │  Removes <meta> immediately after reading
  ▼
background.js (Service Worker, ES module)
  │  Parses tweet data via lib/tweet-parser.js
  │  Deduplicates (Set of seen IDs, max 50k, persisted to chrome.storage.local)
  │  Batches (50 tweets or 30–45s jittered flush)
  │  Debug logging: intercepts console.log/warn/error, sends to native host
  ▼
native-host/xtap_host.py (Python, stdio)
  │  Receives batches via Chrome native messaging protocol
  │  Per-message error handling (responds with error instead of crashing)
  │  Handles tweet writes, debug log writes, and path validation tests
  ▼
tweets-YYYY-MM-DD.jsonl  (daily rotation)
debug-YYYY-MM-DD.log     (when debug logging enabled)
```

### Key Design Decisions

- **Two content scripts (MAIN + ISOLATED):** Chrome MV3 requires this split. MAIN world can patch browser APIs but can't use chrome.runtime. ISOLATED world bridges the gap.
- **Random event channel:** The CustomEvent name is generated per page load (`'_' + Math.random().toString(36).slice(2)`) and passed via a `<meta>` tag that's immediately removed. Avoids predictable DOM markers.
- **Native messaging for file I/O:** Chrome extensions can't write to arbitrary filesystem paths. The Python host handles all file writes via stdio-based native messaging.
- **Dedup in service worker:** Multiple tabs feed the same service worker. `seenIds` Set (max 50,000, FIFO eviction) prevents duplicates. Persisted to `chrome.storage.local` across sessions. The native host also loads seen IDs from existing JSONL files on startup.
- **Jittered flush:** Batch flush uses `setTimeout` with randomized interval (30s base + up to 50% jitter = 30–45s), re-randomized each cycle. Avoids clockwork-regular patterns.
- **Path validation:** When the user sets a custom output directory, the service worker sends a `TEST_PATH` message to the native host, which attempts `makedirs` + write/delete of a temp file before accepting the path.
- **Error resilience:** The native host wraps per-message handling in try/except and responds with `{ok: false, error: "..."}` instead of crashing. The service worker tracks rapid disconnects to detect crash loops.

## Stealth Constraints

**These are non-negotiable. xTap must remain completely passive.**

1. **Zero extra network requests** — never fetch, POST, or call any X/Twitter endpoint. The extension only reads responses the browser already received.
2. **Native-looking patches** — `toString()` on patched `fetch` returns `'function fetch() { [native code] }'`. `XHR.open` toString returns the original native string. `fetch.name` is set to `'fetch'` via `Object.defineProperty`.
3. **No expando properties** — XHR URL tracking uses a `WeakMap`, never attaches properties to instances.
4. **No DOM footprint** — no injected elements, no visible page modifications. The only transient artifact is the `<meta name="__cfg">` tag, removed within milliseconds by the bridge script.
5. **No console output in page context** — all logging happens in the service worker, which runs outside the page's JavaScript environment.
6. **Minimal permissions** — only `storage` and `nativeMessaging`. Host permissions scoped to `x.com` and `twitter.com` only. No `webRequest`, no `tabs`, no `scripting`, no web-accessible resources.
7. **Random event channel** — per-page-load name, meta tag removed immediately after reading.
8. **Only `open()` patched on XHR** — `send()` is not patched, so non-GraphQL XHR calls have clean stack traces.

**Any change that adds network requests to X/Twitter domains must be rejected.**

## File Structure

```
xTap/
├── manifest.json          # MV3 manifest (permissions: storage, nativeMessaging)
├── background.js          # Service worker (ES module) - core logic
├── content-main.js        # MAIN world - fetch/XHR patching
├── content-bridge.js      # ISOLATED world - event relay
├── popup.html/js/css      # Extension popup (stats, pause/resume, output dir, debug toggle)
├── icons/                 # Extension icons (16, 48, 128)
├── lib/
│   └── tweet-parser.js    # GraphQL response → normalized tweet objects
└── native-host/
    ├── xtap_host.py       # Native messaging host (Python, stdio protocol)
    ├── com.xtap.host.json # Native messaging host manifest
    ├── install.sh         # macOS/Linux installer
    ├── install.ps1        # Windows installer
    └── xtap_host.bat      # Windows Python wrapper
```

## Supported Endpoints

The tweet parser (`lib/tweet-parser.js`) has known instruction paths for:

`HomeTimeline`, `HomeLatestTimeline`, `UserTweets`, `UserTweetsAndReplies`, `UserMedia`, `UserLikes`, `TweetDetail`, `SearchTimeline`, `ListLatestTweetsTimeline`, `Bookmarks`, `Likes`, `CommunityTweetsTimeline`, `BookmarkFolderTimeline`

Unknown endpoints fall back to a recursive search for `instructions[]` arrays (max depth 5). Non-tweet endpoints are filtered in `background.js` via `IGNORED_ENDPOINTS`.

## Output Schema

Each JSONL line contains:

```jsonc
{
  "id": "1234567890",
  "url": "https://x.com/handle/status/1234567890",
  "created_at": "2024-01-01T00:00:00.000Z",       // ISO 8601
  "author": {
    "id": "987654321",
    "username": "handle",
    "display_name": "Display Name",
    "verified": false,
    "is_blue_verified": true,
    "follower_count": 1234
  },
  "text": "Full tweet text...",
  "lang": "en",
  "metrics": {
    "likes": 10, "retweets": 5, "replies": 2,
    "views": 1000, "bookmarks": 1, "quotes": 0
  },
  "media": [{"type": "photo|video|animated_gif", "url": "...", "alt_text": "...", "duration_ms": 1234}],
  "urls": [{"display": "...", "expanded": "...", "shortened": "..."}],
  "hashtags": ["tag"],
  "mentions": [{"id": "...", "username": "..."}],
  "in_reply_to": null,
  "quoted_tweet_id": null,
  "conversation_id": "1234567890",
  "is_retweet": false,
  "retweeted_tweet_id": null,
  "is_subscriber_only": false,
  "source_endpoint": "HomeTimeline",
  "captured_at": "2024-01-01T00:00:00.000Z"
}
```

Notes: `media[].duration_ms` only present for videos. `views` may be `null`. For retweets, `text` contains the full original tweet text (not the truncated `RT @user:` form).

## Known Issues

### macOS TCC (Transparency, Consent, and Control)

The native host runs as a standalone `python3` process launched by Chrome via native messaging. It does not inherit Chrome's TCC permissions. Protected paths — iCloud Drive, `~/Documents`, `~/Desktop`, and others — will fail with `PermissionError`. `~/Downloads/xtap` is the safe default (no TCC required).

The path validation feature catches this at save time: the popup shows an error if the native host can't write to the chosen directory.

### Tombstone tweets

X sometimes returns `TimelineTweet` entries where `tweet_results.result` is missing (deleted/suspended tweets). These are skipped by the parser. Since no ID is extracted, they don't enter `seenIds` — if the tweet later appears with full data, it will be captured.

## Development Notes

- **No build step** — plain JS, no bundler, no transpilation. Load and go.
- **Testing:** Load unpacked at `chrome://extensions` with Developer mode. The extension ID changes per install — update `com.xtap.host.json` and re-run the install script.
- **Debugging:** Enable "Debug logging to file" in the popup. Logs write to `debug-YYYY-MM-DD.log` in the output directory. Service worker console is also visible at `chrome://extensions` → xTap → "Inspect views: service worker".
- **tweet-parser.js** is the most fragile file — it handles multiple GraphQL response shapes and X changes their API schema without notice. The recursive fallback (`findInstructionsRecursive`) catches many new endpoint shapes automatically, but field-level changes to tweet objects will need manual updates to `normalizeTweet()`.
- **Service worker module:** `background.js` is loaded as an ES module (`"type": "module"` in manifest). It imports `tweet-parser.js` directly.

## Contributing

- Keep it simple. No build tools, no frameworks, no dependencies beyond Python 3 stdlib.
- Every change must maintain zero network footprint. This is the core promise.
- Stealth constraints are non-negotiable — review the list above before submitting changes.
- Update README.md if changing user-facing behavior.
