# xTap

Passive Chrome extension that captures tweets from X/Twitter as you browse. Intercepts GraphQL API responses the browser already receives and saves them as JSONL via a native messaging host.

## Setup

### 1. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `xtap/` directory
4. Copy the extension ID shown on the card

### 2. Install the native messaging host

```bash
cd native-host
./install.sh <your-extension-id>
```

### 3. Configure output directory (optional)

By default tweets are saved to `~/Downloads/xtap/tweets.jsonl`. To change this, set the `XTAP_OUTPUT_DIR` environment variable before launching Chrome:

```bash
export XTAP_OUTPUT_DIR="$HOME/Documents/xtap-data"
```

### 4. Browse X

Open [x.com](https://x.com) and browse normally. The badge counter on the extension icon shows how many tweets have been captured this session. Click the extension icon to see stats and pause/resume capture.

## Output format

Each line in `tweets.jsonl` is a JSON object with this schema:

```json
{
  "id": "1234567890",
  "created_at": "Mon Jan 01 00:00:00 +0000 2024",
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
    "likes": 10,
    "retweets": 5,
    "replies": 2,
    "views": 1000,
    "bookmarks": 1,
    "quotes": 0
  },
  "media": [],
  "urls": [],
  "hashtags": [],
  "mentions": [],
  "in_reply_to": null,
  "quoted_tweet_id": null,
  "conversation_id": "1234567890",
  "is_retweet": false,
  "retweeted_tweet_id": null,
  "source_endpoint": "HomeTimeline",
  "captured_at": "2024-01-01T00:00:00.000Z"
}
```

## Requirements

- macOS
- Google Chrome
- Python 3
