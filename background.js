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
  const { language, exactMatch, size } = await chrome.storage.sync.get({
    language: DEFAULT_LANG,
    exactMatch: true,
    size: "medium",
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

  // the Large popup also shows infobox-style quick facts from Wikidata
  const facts =
    size === "large" && data.wikibase_item
      ? await fetchFacts(data.wikibase_item)
      : [];

  return {
    title: data.title,
    extract: data.extract,
    thumbnail,
    facts,
    pageUrl:
      data.content_urls?.desktop?.page ??
      `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
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

async function fetchFacts(qid) {
  try {
    // both Wikidata calls are anonymous CORS requests (origin=*), so no
    // extra host permissions are needed
    const res = await fetch(
      "https://www.wikidata.org/w/api.php?action=wbgetentities" +
        `&ids=${qid}&props=claims&format=json&origin=*`
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

    // item-valued claims (occupation, country, …) hold Q-ids; resolve them
    // to English labels in one batch request
    const labels = {};
    if (itemIds.size) {
      const res2 = await fetch(
        "https://www.wikidata.org/w/api.php?action=wbgetentities" +
          `&ids=${[...itemIds].join("|")}&props=labels&languages=en` +
          "&format=json&origin=*"
      );
      if (res2.ok) {
        for (const [id, entity] of Object.entries(
          (await res2.json()).entities ?? {}
        )) {
          labels[id] = entity.labels?.en?.value;
        }
      }
    }

    const facts = [];
    for (const { label, type, values } of picked) {
      let text = null;
      if (type === "time") text = formatWikidataTime(values[0]);
      else if (type === "quantity")
        text = Number(values[0].amount).toLocaleString("en");
      else if (type === "url")
        text = values[0].replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
      else if (type === "item")
        text = values.map((v) => labels[v.id]).filter(Boolean).join(", ");
      if (text) facts.push({ label, value: text });
      if (facts.length >= 5) break;
    }
    return facts;
  } catch {
    return []; // facts are a bonus — never block the popup on them
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
