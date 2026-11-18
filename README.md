# TikTok Search API

A Cloudflare Worker that searches TikTok and returns structured JSON: the
search query, result tabs, video/photo result cards (author, caption,
hashtags, sound, thumbnail, views/likes, top-liked flag), featured users
with their posts, and page context (language, region, geo). No API key
needed, CORS open.

## Live

```
https://tiktok-search-api.14-14.workers.dev/?q=sidhu
```

## Endpoints

```
GET  /?q=<search term>                 search (video results by default)
GET  /?q=<search term>&tab=top         Top tab: mixed videos, photos, user cards
GET  /?q=<search term>&scroll=N        scroll rounds to load more results (default 5, 0-10)
GET  /?q=<search term>&raw=1           include the full rehydration JSON in `context`
GET  /?q=<search term>&debug=1         add a debug object (final URL, title, data-e2e counts)
POST /?q=<search term>                 post a saved TikTok search page HTML as the body
```

Example response (shortened):

```json
{
  "success": true,
  "source": "browser-rendering",
  "query": "sidhu",
  "totalItems": 12,
  "totalFeaturedUsers": 1,
  "tab": "video",
  "tabs": ["Top", "Users", "Videos", "LIVE", "Photo"],
  "items": [
    {
      "id": "7461234567890123456",
      "type": "video",
      "url": "https://www.tiktok.com/@handle/video/7461234567890123456",
      "authorHandle": "handle",
      "authorName": "Name",
      "caption": "caption text #hashtag",
      "hashtags": ["hashtag"],
      "sound": "original sound - handle",
      "thumbnail": "https://...",
      "likesOrViewsText": "12.3K",
      "likesOrViewsCount": 12300,
      "isTopLiked": false
    }
  ],
  "featuredUsers": [
    {
      "handle": "handle",
      "profileUrl": "https://www.tiktok.com/@handle",
      "posts": []
    }
  ],
  "context": { "language": "en", "region": "US" }
}
```

## How it works

Three modes, in order:

1. **POST raw HTML** — post a saved TikTok search page
   (`tiktok.com/search?q=...`) as the request body and the Worker parses it.
   Best for testing.
2. **Cloudflare Browser Rendering** — when the `BROWSER` binding is present,
   the Worker opens the search page in headless Chromium (via
   `@cloudflare/puppeteer`) so the client-side results load, then parses the
   rendered DOM with HTMLRewriter. The browser session is reused across
   requests so TikTok's device cookies survive between calls.
3. **Direct fetch** — plain HTTP fetch fallback. TikTok's search page is
   client-side rendered, so this usually only gets the empty SSR shell.

The parser reads the result cards (`data-e2e="search_top-item"` /
`search_video-item`, `user-post-item`, `#search-tabs`) and the
`__UNIVERSAL_DATA_FOR_REHYDRATION__` script for context.

## Note on empty results

TikTok gates search results behind bot detection: an automated browser
session may get only skeleton placeholders and no result cards. When no
items are found the API returns a `warning` field explaining this. To get
real results, store a logged-in TikTok cookie as a Worker secret (never
commit a real cookie value):

```sh
wrangler secret put TIKTOK_COOKIE
```

Paste the cookies as one `name=value; name=value; ...` string. Or POST HTML
saved from a real browser where results show.

## Deploy

```sh
npm install
npx wrangler deploy
```

`wrangler.toml` uses `compatibility_date = "2025-01-01"` and
`compatibility_flags = ["nodejs_compat"]`. The flag is required: without
it the deploy fails with `No such module "node:fs"` from
`@cloudflare/puppeteer` (pinned to 2.0.1 in `package.json`).

Local test: `npx wrangler dev` works, but Browser Rendering does not run
locally. Locally the Worker falls back to direct fetch, so use POST with
saved HTML to test the parser.
