// xTap — Tweet parser
// Extracts and normalizes tweets from X/Twitter GraphQL API responses.

/**
 * Main entry point. Given an endpoint name and the raw GraphQL response data,
 * returns an array of normalized tweet objects.
 */
export function extractTweets(endpoint, data) {
  if (!data) return [];

  const instructions = findInstructions(endpoint, data);
  if (!instructions || !Array.isArray(instructions)) return [];

  const tweets = [];

  for (const instruction of instructions) {
    const entries = instruction.entries || instruction.moduleItems || [];

    // TimelineAddEntries / TimelineAddToModule
    for (const entry of entries) {
      const extracted = extractTweetsFromEntry(entry);
      tweets.push(...extracted);
    }

    // Some instructions have entry directly (TimelineReplaceEntry)
    if (instruction.entry) {
      tweets.push(...extractTweetsFromEntry(instruction.entry));
    }
  }

  return tweets;
}

/**
 * Navigate to the instructions[] array. Different endpoints nest it at different paths.
 */
function findInstructions(endpoint, data) {
  // Known paths per endpoint type
  const paths = {
    HomeTimeline: ['data', 'home', 'home_timeline_urt', 'instructions'],
    HomeLatestTimeline: ['data', 'home', 'home_timeline_urt', 'instructions'],
    UserTweets: ['data', 'user', 'result', 'timeline_v2', 'timeline', 'instructions'],
    UserTweetsAndReplies: ['data', 'user', 'result', 'timeline_v2', 'timeline', 'instructions'],
    UserMedia: ['data', 'user', 'result', 'timeline_v2', 'timeline', 'instructions'],
    UserLikes: ['data', 'user', 'result', 'timeline_v2', 'timeline', 'instructions'],
    TweetDetail: ['data', 'threaded_conversation_with_injections_v2', 'instructions'],
    SearchTimeline: ['data', 'search_by_raw_query', 'search_timeline', 'timeline', 'instructions'],
    ListLatestTweetsTimeline: ['data', 'list', 'tweets_timeline', 'timeline', 'instructions'],
    Bookmarks: ['data', 'bookmark_timeline_v2', 'timeline', 'instructions'],
    Likes: ['data', 'user', 'result', 'timeline_v2', 'timeline', 'instructions'],
  };

  const path = paths[endpoint];
  if (path) {
    const result = navigatePath(data, path);
    if (result) return result;
  }

  // Generic fallback: recursively search for an instructions array
  return findInstructionsRecursive(data, 3);
}

function navigatePath(obj, path) {
  let current = obj;
  for (const key of path) {
    if (current == null || typeof current !== 'object') return null;
    current = current[key];
  }
  return current;
}

function findInstructionsRecursive(obj, maxDepth) {
  if (maxDepth <= 0 || obj == null || typeof obj !== 'object') return null;

  if (Array.isArray(obj.instructions)) {
    // Verify it looks like timeline instructions
    const hasEntries = obj.instructions.some(i =>
      i.type === 'TimelineAddEntries' || i.entries || i.type === 'TimelineAddToModule'
    );
    if (hasEntries) return obj.instructions;
  }

  for (const key of Object.keys(obj)) {
    if (key === 'instructions') continue;
    const result = findInstructionsRecursive(obj[key], maxDepth - 1);
    if (result) return result;
  }

  return null;
}

/**
 * Extract tweets from a single timeline entry.
 */
function extractTweetsFromEntry(entry) {
  const tweets = [];

  const content = entry.content || entry;

  // Cursor entries — skip
  if (content.entryType === 'TimelineTimelineCursor' || content.cursorType) {
    return tweets;
  }

  // Single tweet item
  if (content.entryType === 'TimelineTimelineItem' || content.__typename === 'TimelineTimelineItem') {
    const tweet = extractFromItemContent(content.itemContent);
    if (tweet) tweets.push(tweet);
    return tweets;
  }

  // Thread / conversation module
  if (content.entryType === 'TimelineTimelineModule' || content.__typename === 'TimelineTimelineModule') {
    const items = content.items || [];
    for (const item of items) {
      const itemContent = item.item?.itemContent || item.itemContent;
      const tweet = extractFromItemContent(itemContent);
      if (tweet) tweets.push(tweet);
    }
    return tweets;
  }

  // Fallback: try itemContent directly
  if (content.itemContent) {
    const tweet = extractFromItemContent(content.itemContent);
    if (tweet) tweets.push(tweet);
  }

  return tweets;
}

function extractFromItemContent(itemContent) {
  if (!itemContent) return null;

  // Only process tweet types
  if (itemContent.itemType !== 'TimelineTweet' && itemContent.__typename !== 'TimelineTweet') {
    return null;
  }

  const tweetResults = itemContent.tweet_results;
  if (!tweetResults?.result) return null;

  const raw = unwrapTweetResult(tweetResults.result);
  if (!raw) return null;

  return normalizeTweet(raw);
}

/**
 * Unwrap tweet result — handles Tweet, TweetWithVisibilityResults, tombstones.
 */
function unwrapTweetResult(result) {
  if (!result) return null;

  const typename = result.__typename;

  if (typename === 'Tweet') return result;

  if (typename === 'TweetWithVisibilityResults') {
    return result.tweet || null;
  }

  // Tombstones, unavailable tweets — skip
  if (typename === 'TweetTombstone' || typename === 'TweetUnavailable') {
    return null;
  }

  // Unknown type but has legacy data — try anyway
  if (result.legacy && result.core) return result;

  return null;
}

/**
 * Normalize a raw tweet into our output schema.
 */
function normalizeTweet(raw) {
  const legacy = raw.legacy;
  if (!legacy) return null;

  const userResult = raw.core?.user_results?.result;
  const userCore = userResult?.core;      // X nests name/screen_name here
  const userLegacy = userResult?.legacy;  // follower_count, verified, etc.

  const text = extractFullText(raw);
  const media = extractMedia(legacy);
  const urls = extractUrls(legacy);

  const tweet = {
    id: legacy.id_str || raw.rest_id,
    created_at: legacy.created_at,
    author: {
      id: userResult?.rest_id || legacy.user_id_str,
      username: userCore?.screen_name || userLegacy?.screen_name,
      display_name: userCore?.name || userLegacy?.name,
      verified: userLegacy?.verified || false,
      is_blue_verified: userResult?.is_blue_verified || false,
      follower_count: userLegacy?.followers_count
    },
    text,
    lang: legacy.lang,
    metrics: {
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      replies: legacy.reply_count || 0,
      views: parseInt(raw.views?.count, 10) || null,
      bookmarks: legacy.bookmark_count || 0,
      quotes: legacy.quote_count || 0
    },
    media,
    urls,
    hashtags: (legacy.entities?.hashtags || []).map(h => h.text),
    mentions: (legacy.entities?.user_mentions || []).map(m => ({
      id: m.id_str,
      username: m.screen_name
    })),
    in_reply_to: legacy.in_reply_to_status_id_str || null,
    quoted_tweet_id: legacy.quoted_status_id_str || null,
    conversation_id: legacy.conversation_id_str || null,
    is_retweet: !!legacy.retweeted_status_result,
    retweeted_tweet_id: legacy.retweeted_status_result?.result?.legacy?.id_str || null,
    source_endpoint: null, // Set by caller
    captured_at: new Date().toISOString()
  };

  // If this is a retweet, also normalize the retweeted tweet
  // (the text of a retweet is often truncated with "RT @user:")
  if (legacy.retweeted_status_result?.result) {
    const rtRaw = unwrapTweetResult(legacy.retweeted_status_result.result);
    if (rtRaw) {
      tweet.text = extractFullText(rtRaw);
    }
  }

  // If there's a quoted tweet, capture its ID (already done above)
  // We don't recursively normalize quoted tweets to keep output flat

  return tweet;
}

/**
 * Extract full text, preferring note_tweet (long-form) over legacy.full_text.
 */
function extractFullText(raw) {
  const noteText = raw.note_tweet?.note_tweet_results?.result?.text;
  if (noteText) return noteText;
  return raw.legacy?.full_text || '';
}

/**
 * Extract media from extended_entities.
 */
function extractMedia(legacy) {
  const mediaList = legacy.extended_entities?.media || legacy.entities?.media || [];
  return mediaList.map(m => {
    const item = {
      type: m.type, // photo, video, animated_gif
      url: null,
      alt_text: m.ext_alt_text || null
    };

    if (m.type === 'photo') {
      item.url = m.media_url_https ? m.media_url_https + ':orig' : m.media_url_https;
    } else if (m.type === 'video' || m.type === 'animated_gif') {
      // Pick highest bitrate mp4 variant
      const variants = m.video_info?.variants || [];
      const mp4s = variants
        .filter(v => v.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      item.url = mp4s[0]?.url || null;
      if (m.type === 'video') {
        item.duration_ms = m.video_info?.duration_millis || null;
      }
    }

    return item;
  });
}

/**
 * Extract URLs from entities.
 */
function extractUrls(legacy) {
  const urlList = legacy.entities?.urls || [];
  return urlList.map(u => ({
    display: u.display_url,
    expanded: u.expanded_url,
    shortened: u.url
  }));
}
