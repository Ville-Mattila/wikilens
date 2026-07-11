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
  lookupArticle(message.title, senderKey)
    .then((data) => {
      sendResponse({ ok: true, data });
      if (!data?.disambiguation) recordRecent(data); // fire-and-forget
    })
    .catch(() => sendResponse({ ok: false }));

  return true; // keep the message channel open for the async response
});

// Records a successful (non-disambiguation) lookup into chrome.storage.local
// so the toolbar popup can show recent lookups. Local-only and best-effort:
// never let a storage failure affect the lookup response.
const RECENTS_KEY = "recents";
const RECENTS_LIMIT = 10;

async function recordRecent(data) {
  try {
    const { [RECENTS_KEY]: recents } = await chrome.storage.local.get({
      [RECENTS_KEY]: [],
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
    });
  } catch {
    // best-effort only
  }
}

async function lookupArticle(title, senderKey = "extension") {
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
        const result = await lookupInLanguage(title, lang, {
          exactMatch,
          size,
          signal: abort.signal,
        });
        cacheSet(cacheKey, result);
        return result;
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        // lookupInLanguage only ever throws for "not found" reasons (404,
        // non-standard type, exact-title mismatch, or a failed
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

// Performs the lookup against a single Wikipedia language edition. Returns
// either a normal article result or a disambiguation result. Throws on any
// "not found" condition (404, non-standard type, exact-title mismatch) so
// the caller can decide whether to fall back to another language.
async function lookupInLanguage(title, lang, { exactMatch, size, signal }) {
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

  // the Large popup also shows infobox-style quick facts from Wikidata;
  // gallery images feed the popup's image carousel — fetch both in parallel
  const [facts, images] = await Promise.all([
    size === "large" && data.wikibase_item
      ? fetchFacts(data.wikibase_item, lang, signal)
      : [],
    fetchImages(data.title, lang, thumbnail, signal),
  ]);

  return {
    title: data.title,
    extract: data.extract,
    // first paragraph with Wikipedia's own formatting (bold subject,
    // italics, sub/superscripts); the popup sanitizes before rendering
    extractHtml: data.extract_html ?? null,
    thumbnail,
    images,
    facts,
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
// render each value segment as a link when one exists.
async function fetchFacts(qid, language, signal) {
  try {
    // both Wikidata calls are anonymous CORS requests (origin=*), so no
    // extra host permissions are needed
    const res = await fetch(
      "https://www.wikidata.org/w/api.php?action=wbgetentities" +
        `&ids=${qid}&props=claims&format=json&origin=*`,
      { signal, headers: API_HEADERS }
    );
    if (!res.ok) return [];
    const claims = (await res.json()).entities?.[qid]?.claims;
    if (!claims) return [];

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
    // English labels and Wikipedia article titles in one batch request, so
    // each can render as a link to its own article
    const wiki = `${language}wiki`;
    const labels = {};
    const articles = {};
    if (itemIds.size) {
      const res2 = await fetch(
        "https://www.wikidata.org/w/api.php?action=wbgetentities" +
          `&ids=${[...itemIds].join("|")}&props=labels%7Csitelinks` +
          `&languages=en&sitefilter=${wiki}%7Cenwiki&format=json&origin=*`,
        { signal, headers: API_HEADERS }
      );
      if (res2.ok) {
        for (const [id, entity] of Object.entries(
          (await res2.json()).entities ?? {}
        )) {
          labels[id] = entity.labels?.en?.value;
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
    return facts;
  } catch (err) {
    // facts are a bonus and never block the popup on them — except an abort,
    // which means a newer lookup superseded this one and must propagate up
    // so lookupArticle doesn't cache an incomplete result under a stale key.
    if (err?.name === "AbortError") throw err;
    return [];
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
