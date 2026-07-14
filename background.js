// Service worker: looks up the selected text as an exact Wikipedia article title.
// Runs the fetch here (not in the content script) so page CSP/CORS rules
// on arbitrary sites can never block the request.

const DEFAULT_LANG = "en";

// Caches both hits and misses for repeated selections (e.g. re-selecting the
// same non-article phrase). Reset whenever the service worker sleeps/wakes,
// which is fine — there's no need to persist this across restarts.
const CACHE_LIMIT = 200;
const lookupCache = new Map();
const CACHE_MISS = Symbol("miss"); // marks a cached negative result

// The in-memory cache dies with the worker; mirror it in
// chrome.storage.session (memory-only, survives worker restarts within the
// browser session) so repeat lookups stay instant after the worker naps.
const SESSION_CACHE_KEY = "wlCache";
let cacheSaveTimer = null;

(async () => {
  try {
    const { [SESSION_CACHE_KEY]: saved } =
      await chrome.storage.session.get(SESSION_CACHE_KEY);
    if (saved) {
      for (const [key, value] of saved) {
        if (!lookupCache.has(key)) {
          lookupCache.set(key, value?.__miss ? CACHE_MISS : value);
        }
      }
    }
  } catch {
    // storage.session unavailable: purely in-memory cache, as before
  }
})();

function persistCache() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    const entries = [...lookupCache].map(([key, value]) => [
      key,
      value === CACHE_MISS ? { __miss: true } : value,
    ]);
    try {
      chrome.storage.session
        .set({ [SESSION_CACHE_KEY]: entries })
        ?.catch(() => {});
    } catch {
      // best-effort only
    }
  }, 400);
}

// ids tie a fast core response to the enrichment that follows it
let lookupSeq = 0;

// Aborts an in-flight lookup when a newer one supersedes it. Keyed per
// source (tab id, or "extension" for the toolbar popup) so lookups from
// different tabs never cancel each other.
const abortControllers = new Map();

// Wikimedia API etiquette: identify the client on every API request.
const API_HEADERS = {
  "Api-User-Agent":
    `WikiLens/${chrome.runtime.getManifest().version} ` +
    "(https://github.com/Ville-Mattila/wikilens)",
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "wikilens-lookup") return;

  const senderKey = sender.tab?.id ?? "extension";
  lookupArticle(message.title, senderKey, sender.tab?.id)
    .then((data) => {
      sendResponse({ ok: true, data });
      if (!data?.disambiguation) recordRecent(data); // fire-and-forget
    })
    .catch(() => sendResponse({ ok: false }));

  return true; // keep the message channel open for the async response
});

// Keyboard shortcut: ask the content script on the active tab to look up
// the current text selection. Fire-and-forget — chrome:// and other
// extension-restricted pages have no content script listening, so a
// missing-receiver error is expected there and safely ignored.
chrome.commands.onCommand.addListener((command) => {
  if (command !== "lookup-selection") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "wikilens-trigger" }, () => {
      void chrome.runtime.lastError; // swallow "no receiving end" errors
    });
  });
});

// Records a successful (non-disambiguation) lookup into chrome.storage.local
// so the toolbar popup can show recent lookups. Local-only and best-effort:
// never let a storage failure affect the lookup response.
const RECENTS_KEY = "recents";
const RECENTS_LIMIT = 10;

async function recordRecent(data) {
  try {
    const { [RECENTS_KEY]: recents, lookupCount } =
      await chrome.storage.local.get({
        [RECENTS_KEY]: [],
        lookupCount: 0,
      });
    const entry = {
      title: data.title,
      pageUrl: data.pageUrl,
      thumbnail: data.thumbnail ?? null,
      ts: Date.now(),
    };
    const deduped = recents.filter((r) => r.pageUrl !== entry.pageUrl);
    deduped.unshift(entry);
    await chrome.storage.local.set({
      [RECENTS_KEY]: deduped.slice(0, RECENTS_LIMIT),
      lookupCount: lookupCount + 1,
    });
  } catch {
    // best-effort only
  }
}

// Latency architecture: the popup opens on the "core" result alone (one
// summary request, two in the language-fallback case). Facts, gallery
// images, and audio are fetched AFTER responding and streamed to the open
// popup via a wikilens-enrich message, so slow Wikidata calls never delay
// the popup itself.
async function lookupArticle(title, senderKey = "extension", tabId = null) {
  const { language, exactMatch, size } = await chrome.storage.sync.get({
    language: DEFAULT_LANG,
    exactMatch: true,
    size: "medium",
  });

  const cacheKey = `${language}|${exactMatch}|${size}|${title.toLowerCase()}`;
  if (lookupCache.has(cacheKey)) {
    const cached = lookupCache.get(cacheKey);
    if (cached === CACHE_MISS) throw new Error("cached miss");
    return cached;
  }

  abortControllers.get(senderKey)?.abort();
  const abort = new AbortController();
  abortControllers.set(senderKey, abort);

  // Try the user's language first; if it's not English and the lookup fails
  // for a "not found" reason (404, exact-title mismatch, disambiguation-less
  // non-standard type), retry the identical logic against English once
  // before giving up. AbortErrors (superseded lookups) must propagate
  // immediately rather than trigger a fallback attempt.
  const languages = language === "en" ? [language] : [language, "en"];

  try {
    let lastErr;
    for (let i = 0; i < languages.length; i++) {
      const lang = languages[i];
      try {
        const core = await lookupCoreInLanguage(title, lang, {
          exactMatch,
          signal: abort.signal,
        });

        const lookupId = ++lookupSeq;
        const result = { ...core, lookupId };
        if (!result.disambiguation) {
          result.images = result.thumbnail ? [result.thumbnail] : [];
          result.facts = [];
          result.audioUrl = null;
          // deliberately not awaited: the popup is already opening
          enrichArticle(result, lang, size, cacheKey, tabId, abort.signal);
        }
        cacheSet(cacheKey, result);
        return result;
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        // lookupCoreInLanguage only ever throws for "not found" reasons
        // (404, non-standard type, exact-title mismatch, or a failed
        // disambiguation-links fetch), so it's always safe to fall through
        // to the next language here.
        lastErr = err;
      }
    }
    throw lastErr;
  } catch (err) {
    if (err?.name !== "AbortError") cacheSet(cacheKey, CACHE_MISS);
    throw err;
  } finally {
    if (abortControllers.get(senderKey) === abort) {
      abortControllers.delete(senderKey);
    }
  }
}

// Fetches facts, gallery images, and pronunciation audio for an already
// delivered core result, merges them into the cache, and pushes them to the
// tab whose popup is (probably still) showing this article. Best-effort
// throughout: an abort or failure leaves the core result standing.
async function enrichArticle(core, lang, size, cacheKey, tabId, signal) {
  try {
    const [factsResult, images, fullExtractHtml] = await Promise.all([
      size === "large" && core.wikibaseItem
        ? fetchFacts(core.wikibaseItem, lang, signal)
        : { facts: [], audioUrl: null },
      fetchImages(core.title, lang, core.thumbnail, signal),
      fetchLeadSection(core.title, lang, signal),
    ]);

    const merged = {
      ...core,
      facts: factsResult.facts,
      audioUrl: factsResult.audioUrl,
      images,
      fullExtractHtml,
    };
    cacheSet(cacheKey, merged);

    if (typeof tabId === "number") {
      chrome.tabs.sendMessage(
        tabId,
        {
          type: "wikilens-enrich",
          lookupId: core.lookupId,
          facts: factsResult.facts,
          audioUrl: factsResult.audioUrl,
          images,
          fullExtractHtml,
        },
        () => void chrome.runtime.lastError // tab may be gone; that's fine
      );
    }
  } catch {
    // aborted or failed: the popup already has the core content
  }
}

// The summary API only carries the first paragraph; TextExtracts with
// exintro returns the article's whole lead section (everything before the
// first heading) as limited HTML. Best-effort: null keeps the summary text.
async function fetchLeadSection(title, lang, signal) {
  try {
    const res = await fetch(
      `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts` +
        `&exintro=1&titles=${encodeURIComponent(title)}` +
        "&format=json&formatversion=2&origin=*",
      { signal, headers: API_HEADERS }
    );
    if (!res.ok) return null;
    const extract = (await res.json()).query?.pages?.[0]?.extract;
    return typeof extract === "string" && extract.trim() ? extract : null;
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    return null;
  }
}

// Performs the fast, popup-blocking part of a lookup against a single
// Wikipedia language edition: summary, exactness checks, and disambiguation
// handling. No facts/images/audio here; those are enrichment. Throws on any
// "not found" condition (404, non-standard type, exact-title mismatch) so
// the caller can decide whether to fall back to another language.
async function lookupCoreInLanguage(title, lang, { exactMatch, signal }) {
  const url =
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/` +
    `${encodeURIComponent(title)}`;

  const res = await fetch(url, { signal, headers: API_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();

  if (data.type === "disambiguation") {
    return lookupDisambiguation(data, lang, signal);
  }

  // "standard" = a real article.
  if (data.type !== "standard") throw new Error(`type ${data.type}`);

  // The API resolves redirects server-side even when asked not to
  // (e.g. "USA" returns the "United States" summary). In exact mode,
  // require the selected text to actually be the article's title.
  // Case-insensitive, because MediaWiki titles themselves are
  // case-normalized ("albert einstein" is a valid way to name the
  // "Albert Einstein" article).
  if (exactMatch && data.title.toLowerCase() !== title.trim().toLowerCase()) {
    throw new Error("not an exact title match");
  }

  // Surname/index pages (e.g. "Haaland") are typed "standard" by the API
  // but their whole content is a list of links — the extract is just a
  // referral sentence. Treat them like disambiguation pages, keeping the
  // real intro sentence as the card's subtitle. If the links fetch fails,
  // fall through to the normal card: unlike true disambiguation pages,
  // these are still valid articles.
  const extractText = (data.extract ?? "").trim();
  const looksLikeIndexPage =
    extractText.length < 300 &&
    (/may (also )?refer to/i.test(extractText) ||
      // a bare trailing colon needs corroborating referral wording, so a
      // short ordinary article never renders as a fake link list
      (extractText.endsWith(":") &&
        /refer|list of|stand for|surname|given name/i.test(extractText)));
  if (looksLikeIndexPage) {
    try {
      return await lookupDisambiguation(data, lang, signal, extractText);
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      // no links found — show the regular card below
    }
  }

  // The summary thumbnail is ~330px wide; request a larger rendition so the
  // square popup image stays sharp (the card is 500 CSS px wide, so high-DPI
  // wants ~1000). Wikimedia only serves a fixed set of widths (330/500/960…)
  // and rejects widths beyond the original, so pick the largest safe bucket.
  let thumbnail = data.thumbnail?.source ?? null;
  const originalWidth = data.originalimage?.width ?? 0;
  if (thumbnail && originalWidth > 960) {
    thumbnail = thumbnail.replace(/\/(\d+)px-/, "/960px-");
  } else if (thumbnail && originalWidth > 500) {
    thumbnail = thumbnail.replace(/\/(\d+)px-/, "/500px-");
  }

  return {
    title: data.title,
    extract: data.extract,
    // first paragraph with Wikipedia's own formatting (bold subject,
    // italics, sub/superscripts); the popup sanitizes before rendering
    extractHtml: data.extract_html ?? null,
    thumbnail,
    // enrichArticle needs the entity id later; harmless in the response
    wikibaseItem: data.wikibase_item ?? null,
    pageUrl:
      data.content_urls?.desktop?.page ??
      `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
}

// Collects up to 5 image URLs for the popup's carousel: the sharp summary
// thumbnail first, then the article's gallery images from the media-list
// endpoint (icons and decorations are excluded via showInGallery). Best
// effort — any failure falls back to just the lead thumbnail.
async function fetchImages(title, lang, leadThumbnail, signal) {
  const lead = leadThumbnail ? [leadThumbnail] : [];
  try {
    const res = await fetch(
      `https://${lang}.wikipedia.org/api/rest_v1/page/media-list/` +
        encodeURIComponent(title),
      { signal, headers: API_HEADERS }
    );
    if (!res.ok) return lead;
    const items = (await res.json()).items ?? [];
    const extra = [];
    for (const item of items) {
      if (item.type !== "image" || !item.showInGallery) continue;
      // the lead image is already represented by the sharper thumbnail
      if (item.leadImage) continue;
      // last srcset entry is the highest-resolution rendition Wikimedia
      // itself offers, so it's always a valid width
      const src = item.srcset?.[item.srcset.length - 1]?.src;
      if (!src) continue;
      extra.push(src.startsWith("//") ? "https:" + src : src);
      if (extra.length >= 4) break;
    }
    return [...lead, ...extra].slice(0, 5);
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    return lead;
  }
}

// Fetches up to 8 outgoing article links (namespace 0) for a disambiguation
// page, so the popup can offer them as quick picks. If the links fetch
// fails, throw so the whole lookup is treated as a miss (current behavior).
async function lookupDisambiguation(data, lang, signal, intro = null) {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query` +
    `&titles=${encodeURIComponent(data.title)}` +
    "&prop=links&plnamespace=0&pllimit=12&format=json&origin=*";

  const res = await fetch(url, { signal, headers: API_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const pages = json.query?.pages;
  if (!pages) throw new Error("no disambiguation links");

  const page = Object.values(pages)[0];
  const links = page?.links;
  if (!links || !links.length) throw new Error("no disambiguation links");

  const options = links.slice(0, 8).map((l) => l.title);

  return {
    disambiguation: true,
    title: data.title,
    intro, // referral sentence for index/surname pages; null → generic subtitle
    options,
    pageUrl:
      data.content_urls?.desktop?.page ??
      `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(data.title)}`,
  };
}

function cacheSet(key, value) {
  if (lookupCache.size >= CACHE_LIMIT) {
    lookupCache.delete(lookupCache.keys().next().value); // evict oldest
  }
  lookupCache.set(key, value);
  persistCache();
}

// [property id, display label, value type, max values to join]
const FACT_PROPS = [
  ["P569", "Born", "time", 1],
  ["P570", "Died", "time", 1],
  ["P106", "Occupation", "item", 3],
  ["P27", "Nationality", "item", 2],
  ["P571", "Founded", "time", 1],
  ["P17", "Country", "item", 1],
  ["P36", "Capital", "item", 1],
  ["P1082", "Population", "quantity", 1],
  ["P856", "Website", "url", 1],
];

// Facts are returned as { label, parts: [{ text, href? }] } so the popup can
// render each value segment as a link when one exists. Also resolves P443
// (pronunciation audio) into a Commons file URL, returned separately as
// audioUrl since it's not one of the visible fact rows.
async function fetchFacts(qid, language, signal) {
  try {
    // both Wikidata calls are anonymous CORS requests (origin=*), so no
    // extra host permissions are needed
    const res = await fetch(
      "https://www.wikidata.org/w/api.php?action=wbgetentities" +
        `&ids=${qid}&props=claims&format=json&origin=*`,
      { signal, headers: API_HEADERS }
    );
    if (!res.ok) return { facts: [], audioUrl: null };
    const claims = (await res.json()).entities?.[qid]?.claims;
    if (!claims) return { facts: [], audioUrl: null };

    let audioUrl = null;
    const audioStatements = (claims["P443"] ?? []).filter(
      (s) => s.mainsnak?.snaktype === "value"
    );
    if (audioStatements.length) {
      const filename = audioStatements[0].mainsnak.datavalue.value;
      audioUrl =
        "https://commons.wikimedia.org/wiki/Special:FilePath/" +
        encodeURIComponent(filename);
    }

    const picked = [];
    const itemIds = new Set();
    for (const [pid, label, type, max] of FACT_PROPS) {
      const statements = (claims[pid] ?? []).filter(
        (s) => s.mainsnak?.snaktype === "value"
      );
      if (!statements.length) continue;
      const preferred = statements.filter((s) => s.rank === "preferred");
      const values = (preferred.length ? preferred : statements)
        .slice(0, max)
        .map((s) => s.mainsnak.datavalue.value);
      picked.push({ label, type, values });
      if (type === "item") values.forEach((v) => itemIds.add(v.id));
      if (picked.length >= 6) break;
    }

    // item-valued claims (occupation, country, …) hold Q-ids; resolve their
    // labels (preferring the user's language, falling back to English) and
    // Wikipedia article titles in one batch request, so each can render as
    // a link to its own article
    const wiki = `${language}wiki`;
    const labels = {};
    const articles = {};
    if (itemIds.size) {
      const res2 = await fetch(
        "https://www.wikidata.org/w/api.php?action=wbgetentities" +
          `&ids=${[...itemIds].join("|")}&props=labels%7Csitelinks` +
          `&languages=${language}%7Cen&sitefilter=${wiki}%7Cenwiki&format=json&origin=*`,
        { signal, headers: API_HEADERS }
      );
      if (res2.ok) {
        for (const [id, entity] of Object.entries(
          (await res2.json()).entities ?? {}
        )) {
          labels[id] = entity.labels?.[language]?.value ?? entity.labels?.en?.value;
          const link = entity.sitelinks?.[wiki] ?? entity.sitelinks?.enwiki;
          if (link) {
            const host = entity.sitelinks?.[wiki]
              ? `${language}.wikipedia.org`
              : "en.wikipedia.org";
            articles[id] =
              `https://${host}/wiki/${encodeURIComponent(link.title)}`;
          }
        }
      }
    }

    const facts = [];
    for (const { label, type, values } of picked) {
      let parts = [];
      if (type === "time") {
        const text = formatWikidataTime(values[0]);
        if (text) parts = [{ text }];
      } else if (type === "quantity") {
        parts = [{ text: Number(values[0].amount).toLocaleString("en") }];
      } else if (type === "url") {
        const text = values[0]
          .replace(/^https?:\/\/(www\.)?/, "")
          .replace(/\/$/, "");
        // defense-in-depth: only link out to plain web URLs, never other
        // schemes, no matter what a vandalized Wikidata claim contains
        const safeHref = /^https?:\/\//i.test(values[0]) ? values[0] : null;
        parts = safeHref ? [{ text, href: safeHref }] : [{ text }];
      } else if (type === "item") {
        parts = values
          .filter((v) => labels[v.id])
          .map((v) => ({ text: labels[v.id], href: articles[v.id] }));
      }
      if (parts.length) facts.push({ label, parts });
      if (facts.length >= 5) break;
    }
    return { facts, audioUrl };
  } catch (err) {
    // facts are a bonus and never block the popup on them — except an abort,
    // which means a newer lookup superseded this one and must propagate up
    // so lookupArticle doesn't cache an incomplete result under a stale key.
    if (err?.name === "AbortError") throw err;
    return { facts: [], audioUrl: null };
  }
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December",
];

function formatWikidataTime({ time, precision }) {
  const m = time.match(/^([+-])(\d+)-(\d\d)-(\d\d)/);
  if (!m) return null;
  const [, sign, year, month, day] = m;
  const y = Number(year) * (sign === "-" ? -1 : 1);
  const yearText = y < 0 ? `${-y} BC` : String(y);
  if (precision >= 11) return `${Number(day)} ${MONTHS[Number(month) - 1]} ${yearText}`;
  if (precision === 10) return `${MONTHS[Number(month) - 1]} ${yearText}`;
  return yearText;
}
