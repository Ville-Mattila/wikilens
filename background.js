// Service worker: looks up the selected text as an exact Wikipedia article title.
// Runs the fetch here (not in the content script) so page CSP/CORS rules
// on arbitrary sites can never block the request.

const DEFAULT_LANG = "en";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "wikilens-lookup") return;

  lookupArticle(message.title)
    .then((data) => sendResponse({ ok: true, data }))
    .catch(() => sendResponse({ ok: false }));

  return true; // keep the message channel open for the async response
});

async function lookupArticle(title) {
  const { language, exactMatch } = await chrome.storage.sync.get({
    language: DEFAULT_LANG,
    exactMatch: true,
  });
  const url =
    `https://${language}.wikipedia.org/api/rest_v1/page/summary/` +
    `${encodeURIComponent(title)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  // "standard" = a real article. Excludes disambiguation pages, which have
  // no useful summary to show regardless of the matching mode.
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

  // The summary thumbnail is ~330px wide; request a larger rendition so the
  // square popup image stays sharp. Wikimedia only serves a fixed set of
  // widths (330/500/960...) and rejects widths beyond the original, so use
  // 500px and only when the original allows it.
  let thumbnail = data.thumbnail?.source ?? null;
  if (thumbnail && (data.originalimage?.width ?? 0) > 500) {
    thumbnail = thumbnail.replace(/\/(\d+)px-/, "/500px-");
  }

  return {
    title: data.title,
    extract: data.extract,
    thumbnail,
    pageUrl:
      data.content_urls?.desktop?.page ??
      `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
}
