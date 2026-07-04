# WikiLens

A Chromium extension that shows an instant Wikipedia preview when you select text on any page — but only when the selected text is the exact title of an existing Wikipedia article.

**Landing page & live demo:** https://ville-mattila.github.io/wikilens/

## How it works

1. Select any text on a web page (mouse or keyboard).
2. After a short debounce, the extension asks the Wikipedia REST API whether the selection is an exact article title.
3. If it is, an animated popup springs up next to the selection with:
   - the article's image in a square, portrait-friendly crop (faces stay in frame),
   - the title and the article's full first paragraph, scrollable when long,
   - on the Large size, up to five quick facts from the article's infobox data — born, died, occupation, founded, population, website and the like — where each linkable value (a country, an occupation, a website) is clickable,
   - a **Read in Wikipedia →** link that opens the full article in a new tab.
4. The popup fades away when you click elsewhere or clear the selection.

Redirects (e.g. "USA") and disambiguation pages don't trigger the popup — only exact article titles like "United States" or "Albert Einstein" do. Matching is case-insensitive, mirroring MediaWiki's own title normalization. All animations respect `prefers-reduced-motion`.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome/Edge/Brave.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Visit any page, select e.g. `Albert Einstein`, and the preview appears.

## Settings

Right-click the WikiLens icon → **Options** (opens in its own tab). Settings sync via `chrome.storage.sync` and apply immediately — no reload needed:

- **Wikipedia language** — which Wikipedia edition to search, from 23 choices (default: English). Also used for quick-fact links.
- **Popup size** — Small, Medium, or Large. Small is compact; Medium and Large share roomier dimensions, and Large additionally shows the quick facts block.
- **Theme** — Light or Dark (default: Dark).
- **Exact title matches only** — when on (default), the preview appears only if the selection is exactly an article's title. Turn off to also follow Wikipedia redirects, e.g. selecting "USA" previews "United States". Disambiguation pages never show a preview.

## Quick facts, technically

Every Wikipedia article links a Wikidata entity. For the Large popup, the service worker fetches that entity's claims and resolves a curated set of properties (birth/death dates, occupation, nationality, founding date, country, capital, population, website), then resolves item labels and Wikipedia article links in one batch request. Both are anonymous CORS requests to `wikidata.org` — no extra extension permissions. Facts are best-effort: if anything fails, the popup simply appears without them.

## Files

- `manifest.json` — Manifest V3 config; content script on all pages (except Wikipedia itself), host permission for `*.wikipedia.org`, `storage` permission for settings.
- `content.js` — selection tracking, popup rendering (shadow DOM, so page CSS can't interfere), entrance/exit animations, positioning, size/theme application.
- `background.js` — service worker performing the Wikipedia lookup and the Wikidata quick-facts resolution, avoiding page-level CORS/CSP restrictions.
- `options.html` / `options.js` — the settings page.
- `docs/` — the landing page served by GitHub Pages.
- `store-assets/`, `STORE.md`, `PRIVACY.md`, `scripts/package.ps1` — Chrome Web Store submission materials.
