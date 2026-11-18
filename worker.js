export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim();
    const includeRawMeta = url.searchParams.get("raw") === "1";

    if (!query && request.method !== "POST") {
      return jsonResponse(
        { error: "Missing required query parameter: ?q=sidhu" },
        400
      );
    }

    try {
      let html = "";
      let source = "direct-fetch";
      let cookiesKept = null;
      let sessionReused = null;
      let scrollsDone = null;
      let debugInfo = null;

      const tab = url.searchParams.get("tab") === "top" ? "top" : "video";
      const debug = url.searchParams.get("debug") === "1";

      if (request.method === "POST") {
        html = await request.text();
        source = "posted-html";
      }

      else if (env.BROWSER) {

        const scrollParam = parseInt(url.searchParams.get("scroll") || "5", 10);
        const scrolls = Number.isFinite(scrollParam)
          ? Math.max(0, Math.min(10, scrollParam))
          : 5;
        const rendered = await fetchWithBrowser(query, env, scrolls, tab, debug);
        html = rendered.html;
        source = "browser-rendering";
        cookiesKept = rendered.cookiesKept;
        sessionReused = rendered.sessionReused;
        scrollsDone = rendered.scrollsDone;
        debugInfo = rendered.debug;
      }

      else {
        html = await fetchDirect(query, env, tab);
        source = "direct-fetch";
      }

      const parsed = await parseTikTokSearchHtml(html, query, includeRawMeta);

      const response = {
        success: true,
        source,
        query: parsed.query || query || null,
        totalItems: parsed.items.length,
        totalFeaturedUsers: parsed.featuredUsers.length,
        ...(request.method !== "POST" ? { tab } : {}),
        ...(cookiesKept !== null ? { cookiesKept, sessionReused, scrolls: scrollsDone } : {}),
        ...(debugInfo ? { debug: debugInfo } : {}),
        ...parsed,
      };

      if (parsed.items.length === 0) {
        response.warning =
          "TikTok served no results to this automated browser session (bot detection / login wall — a real browser gets results even logged out). Set a logged-in TIKTOK_COOKIE secret (wrangler secret put TIKTOK_COOKIE) or POST HTML saved from a real browser.";
      }

      return jsonResponse(response);
    } catch (err) {
      return jsonResponse(
        {
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        },
        500
      );
    }
  },
};

async function fetchWithBrowser(query, env, scrolls = 5, tab = "video", debug = false) {
  const puppeteer = await import("@cloudflare/puppeteer");
  const { browser, reused } = await getOrLaunchBrowser(puppeteer, env);

  const ITEM_SELECTOR =
    '[data-e2e="search_top-item"], [data-e2e="search_video-item"]';

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1920, height: 1080 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
      window.chrome = window.chrome || { runtime: {} };
    });

    if (env.TIKTOK_COOKIE) {
      const cookies = env.TIKTOK_COOKIE.split(";").map((pair) => {
        const [name, ...rest] = pair.trim().split("=");
        return {
          name,
          value: rest.join("="),
          domain: ".tiktok.com",
          path: "/",
        };
      });
      await page.setCookie(...cookies);
    }

    const targetUrl = searchUrl(query, tab);
    await page.goto(searchUrl(query, "top"), {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    if (tab === "video") {
      const clicked = await page
        .evaluate(() => {
          const btns = Array.from(
            document.querySelectorAll(
              '#search-tabs button[data-testid="tux-web-tab-bar"]'
            )
          );
          const videos = btns.find(
            (b) => (b.textContent || "").trim().toLowerCase() === "videos"
          );
          if (!videos) return false;
          videos.click();
          return true;
        })
        .catch(() => false);
      if (!clicked) {
        await page
          .goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
          .catch(() => {});
      }

      await new Promise((r) => setTimeout(r, 3000));
    }

    await page.waitForSelector(ITEM_SELECTOR, { timeout: 20000 }).catch(() => {});

    let scrollRounds = 0;
    let noGrowth = 0;
    for (let round = 0; round < scrolls; round++) {
      const before = await page
        .$$eval(ITEM_SELECTOR, (els) => els.length)
        .catch(() => 0);
      await page
        .evaluate(async () => {
          const height = document.body.scrollHeight;
          const step = Math.max(400, Math.floor(height / 3));
          for (let y = 0; y < height; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 250));
          }
          window.scrollTo(0, document.body.scrollHeight);
        })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      const after = await page
        .$$eval(ITEM_SELECTOR, (els) => els.length)
        .catch(() => 0);
      scrollRounds++;
      if (after > before) noGrowth = 0;
      else if (++noGrowth >= 2) break;
    }

    let debugInfo = null;
    if (debug) {
      debugInfo = await page
        .evaluate(() => {
          const e2e = {};
          document.querySelectorAll("[data-e2e]").forEach((el) => {
            const v = el.getAttribute("data-e2e");
            e2e[v] = (e2e[v] || 0) + 1;
          });
          return {
            url: location.href,
            title: document.title,
            e2e,
            videoLinks: document.querySelectorAll('a[href*="/video/"]').length,
            photoLinks: document.querySelectorAll('a[href*="/photo/"]').length,
            bodyText: (document.body.innerText || "").slice(0, 400),
          };
        })
        .catch(() => null);
    }

    const html = await page.content();

    const cookies = await page.cookies().catch(() => []);
    await page.close().catch(() => {});
    return { html, cookiesKept: cookies.length, sessionReused: reused, scrollsDone: scrollRounds, debug: debugInfo };
  } finally {

    await browser.disconnect().catch(() => {});
  }
}

async function getOrLaunchBrowser(puppeteer, env) {
  try {
    const sessions = await puppeteer.default.sessions(env.BROWSER);
    const live = (sessions || []).find((s) => s && (s.sessionId || s.id));
    if (live) {
      const browser = await puppeteer.default.connect(
        env.BROWSER,
        live.sessionId || live.id
      );
      return { browser, reused: true };
    }
  } catch {

  }
  try {
    const browser = await puppeteer.default.launch(env.BROWSER, {
      keep_alive: 600,
    });
    return { browser, reused: false };
  } catch {
    const browser = await puppeteer.default.launch(env.BROWSER);
    return { browser, reused: false };
  }
}

function searchUrl(query, tab) {
  const q = encodeURIComponent(query);
  return tab === "top"
    ? `https://www.tiktok.com/search?q=${q}`
    : `https://www.tiktok.com/search/video?q=${q}`;
}

async function fetchDirect(query, env, tab = "video") {
  const targetUrl = searchUrl(query, tab);
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  if (env.TIKTOK_COOKIE) {
    headers["Cookie"] = env.TIKTOK_COOKIE;
  }

  const res = await fetch(targetUrl, { headers });
  if (!res.ok) {
    throw new Error(`TikTok returned HTTP ${res.status}`);
  }
  return await res.text();
}

async function parseTikTokSearchHtml(html, fallbackQuery, includeRawMeta) {
  const items = [];
  const featuredUsersMap = new Map();
  const userPosts = [];
  const tabs = [];
  let pageQuery = fallbackQuery || "";
  let universalDataRaw = "";

  let currentItem = null;
  let currentUserPost = null;
  let readingCount = false;
  let countBuffer = "";
  let readingTabText = false;
  let tabBuffer = "";

  const registerItemHandlers = (rw, cardSelector) => {
    rw.on(cardSelector, {
      element(el) {
        currentItem = {
          index: items.length,
          id: null,
          type: "video",
          url: null,
          authorHandle: null,
          authorName: null,
          caption: null,
          hashtags: [],
          sound: null,
          rawAlt: null,
          thumbnail: null,
          likesOrViewsText: null,
          likesOrViewsCount: null,
          isTopLiked: false,
        };
        el.onEndTag(() => {
          if (currentItem) {
            items.push(currentItem);
            currentItem = null;
          }
        });
      },
    })
      .on(`${cardSelector} a[href]`, {
        element(el) {
          if (!currentItem) return;
          const href = el.getAttribute("href");
          currentItem.url = href;
          const meta = parseItemUrl(href);
          if (meta) {
            currentItem.authorHandle = meta.authorHandle;
            currentItem.type = meta.type;
            currentItem.id = meta.id;
          }
        },
      })
      .on(`${cardSelector} img`, {
        element(el) {
          if (!currentItem) return;
          const alt = el.getAttribute("alt") || "";
          const src = el.getAttribute("src") || "";

          currentItem.rawAlt = alt;
          const parsedAlt = parseAltText(alt);
          currentItem.caption = parsedAlt.caption;
          currentItem.authorName = parsedAlt.authorName;
          currentItem.sound = parsedAlt.sound;
          currentItem.hashtags = extractHashtags(parsedAlt.caption);

          if (src && !src.startsWith("data:image/")) {
            currentItem.thumbnail = src;
          }
        },
      })
      .on(`${cardSelector} .top-liked-label`, {
        element() {
          if (currentItem) currentItem.isTopLiked = true;
        },
      })
      .on(`${cardSelector} [data-e2e="video-views"]`, {
        element() {
          readingCount = true;
          countBuffer = "";
        },
        text(chunk) {
          if (readingCount) countBuffer += chunk.text;
          if (chunk.lastInTextNode && readingCount) {
            if (currentItem) {
              const text = countBuffer.trim();
              currentItem.likesOrViewsText = text;
              currentItem.likesOrViewsCount = parseCompactNumber(text);
            }
            readingCount = false;
          }
        },
      });
  };

  const rewriter = new HTMLRewriter()

    .on('input[name="q"]', {
      element(el) {
        const val = el.getAttribute("value");
        if (val) pageQuery = val;
      },
    })

    .on('#search-tabs button[data-testid="tux-web-tab-bar"] span', {
      element() {
        readingTabText = true;
        tabBuffer = "";
      },
      text(chunk) {
        if (readingTabText) tabBuffer += chunk.text;
        if (chunk.lastInTextNode && readingTabText) {
          const label = tabBuffer.trim();
          if (label) tabs.push(label);
          readingTabText = false;
        }
      },
    })

    .on('div[data-e2e="search_top-item"]', {
      element(el) {
        currentItem = {
          index: items.length,
          id: null,
          type: "video",
          url: null,
          authorHandle: null,
          authorName: null,
          caption: null,
          hashtags: [],
          sound: null,
          rawAlt: null,
          thumbnail: null,
          likesOrViewsText: null,
          likesOrViewsCount: null,
          isTopLiked: false,
        };
        el.onEndTag(() => {
          if (currentItem) {
            items.push(currentItem);
            currentItem = null;
          }
        });
      },
    })
    .on('div[data-e2e="search_top-item"] a[href]', {
      element(el) {
        if (!currentItem) return;
        const href = el.getAttribute("href");
        currentItem.url = href;
        const meta = parseItemUrl(href);
        if (meta) {
          currentItem.authorHandle = meta.authorHandle;
          currentItem.type = meta.type;
          currentItem.id = meta.id;
        }
      },
    })
    .on('div[data-e2e="search_top-item"] img', {
      element(el) {
        if (!currentItem) return;
        const alt = el.getAttribute("alt") || "";
        const src = el.getAttribute("src") || "";

        currentItem.rawAlt = alt;
        const parsedAlt = parseAltText(alt);
        currentItem.caption = parsedAlt.caption;
        currentItem.authorName = parsedAlt.authorName;
        currentItem.sound = parsedAlt.sound;
        currentItem.hashtags = extractHashtags(parsedAlt.caption);

        if (src && !src.startsWith("data:image/")) {
          currentItem.thumbnail = src;
        }
      },
    })
    .on('div[data-e2e="search_top-item"] .top-liked-label', {
      element() {
        if (currentItem) currentItem.isTopLiked = true;
      },
    })
    .on('div[data-e2e="search_top-item"] [data-e2e="video-views"]', {
      element() {
        readingCount = true;
        countBuffer = "";
      },
      text(chunk) {
        if (readingCount) countBuffer += chunk.text;
        if (chunk.lastInTextNode && readingCount) {
          if (currentItem) {
            const text = countBuffer.trim();
            currentItem.likesOrViewsText = text;
            currentItem.likesOrViewsCount = parseCompactNumber(text);
          }
          readingCount = false;
        }
      },
    })

    .on('#search_top-item-list a[href^="/@"]', {
      element(el) {
        const href = el.getAttribute("href");
        if (!href) return;
        const handle = href.replace(/^\/@/, "").split(/[/?#]/)[0];
        if (handle && !featuredUsersMap.has(handle)) {
          featuredUsersMap.set(handle, {
            handle,
            profileUrl: `https://www.tiktok.com/@${handle}`,
            posts: [],
          });
        }
      },
    })

    .on('div[data-e2e="user-post-item"]', {
      element(el) {
        currentUserPost = {
          id: null,
          type: "video",
          url: null,
          authorHandle: null,
          authorName: null,
          caption: null,
          hashtags: [],
          sound: null,
          rawAlt: null,
          thumbnail: null,
        };
        el.onEndTag(() => {
          if (currentUserPost) {
            userPosts.push(currentUserPost);
            currentUserPost = null;
          }
        });
      },
    })
    .on('div[data-e2e="user-post-item"] a[href]', {
      element(el) {
        if (!currentUserPost) return;
        const href = el.getAttribute("href");
        currentUserPost.url = href;
        const meta = parseItemUrl(href);
        if (meta) {
          currentUserPost.authorHandle = meta.authorHandle;
          currentUserPost.type = meta.type;
          currentUserPost.id = meta.id;
        }
      },
    })
    .on('div[data-e2e="user-post-item"] img', {
      element(el) {
        if (!currentUserPost) return;
        const alt = el.getAttribute("alt") || "";
        const src = el.getAttribute("src") || "";

        currentUserPost.rawAlt = alt;
        const parsedAlt = parseAltText(alt);
        currentUserPost.caption = parsedAlt.caption;
        currentUserPost.authorName = parsedAlt.authorName;
        currentUserPost.sound = parsedAlt.sound;
        currentUserPost.hashtags = extractHashtags(parsedAlt.caption);

        if (src && !src.startsWith("data:image/")) {
          currentUserPost.thumbnail = src;
        }
      },
    })

    .on("script#__UNIVERSAL_DATA_FOR_REHYDRATION__", {
      text(chunk) {
        universalDataRaw += chunk.text;
      },
    });

  registerItemHandlers(rewriter, 'div[data-e2e="search_video-item"]');

  await rewriter.transform(new Response(html)).text();

  for (const post of userPosts) {
    if (post.authorHandle) {
      if (!featuredUsersMap.has(post.authorHandle)) {
        featuredUsersMap.set(post.authorHandle, {
          handle: post.authorHandle,
          profileUrl: `https://www.tiktok.com/@${post.authorHandle}`,
          posts: [],
        });
      }
      featuredUsersMap.get(post.authorHandle).posts.push(post);
    }
  }

  let context = null;
  if (universalDataRaw) {
    try {
      const json = JSON.parse(universalDataRaw);
      const scope = json?.__DEFAULT_SCOPE__ || {};
      const appCtx = scope["webapp.app-context"] || {};
      const bizCtx = scope["webapp.biz-context"] || {};

      context = includeRawMeta
        ? json
        : {
            language: appCtx.language,
            region: appCtx.region,
            clusterRegion: appCtx.clusterRegion,
            geoCity: bizCtx.geoCity || null,
            vregion: bizCtx.vregion || null,
            os: bizCtx.os || null,
            user: appCtx.user
              ? {
                  uid: appCtx.user.uid,
                  uniqueId: appCtx.user.uniqueId,
                  nickName: appCtx.user.nickName,
                  region: appCtx.user.region,
                }
              : null,
          };
    } catch {
      context = null;
    }
  }

  return {
    query: pageQuery,
    tabs,
    items,
    featuredUsers: Array.from(featuredUsersMap.values()),
    context,
  };
}

function parseItemUrl(href) {
  if (!href) return null;
  const match = href.match(/tiktok\.com\/@([^/]+)\/(video|photo)\/(\d+)/i);
  if (!match) return null;
  return {
    authorHandle: match[1],
    type: match[2].toLowerCase(),
    id: match[3],
  };
}

function parseAltText(alt) {
  const match = alt.match(/^(.*?)\s+created by\s+(.+?)\s+with\s+(.+)$/s);
  if (!match) {
    return { caption: alt.trim(), authorName: null, sound: null };
  }
  return {
    caption: match[1].trim(),
    authorName: match[2].trim(),
    sound: match[3].trim(),
  };
}

function extractHashtags(text) {
  if (!text) return [];
  return [...text.matchAll(/#([^\s#]+)/g)].map((m) => m[1]);
}

function parseCompactNumber(str) {
  if (!str) return null;
  const match = str.trim().match(/^([\d.]+)\s*([KMB])?$/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const suffix = (match[2] || "").toUpperCase();
  const multipliers = { "": 1, K: 1e3, M: 1e6, B: 1e9 };
  return Math.round(num * (multipliers[suffix] || 1));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
