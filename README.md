# WikiLens

A browser extension (Chromium and Firefox) that shows an instant Wikipedia preview when you select text on any page — but only when the selected text is the exact title of an existing Wikipedia article.

**Landing page & live demo:** https://ville-mattila.github.io/wikilens/

## How it works

1. Select any text on a web page (mouse or keyboard).
2. After a short debounce, the extension asks the Wikipedia REST API whether the selection is an exact article title.
3. If it is, an animated popup springs up next to the selection with:
   - the article's image, shown whole at its natural aspect ratio — and when the article has more images, a small arrow flips through up to five of them,
   - the title and the article's full first paragraph, scrollable when long,
   - on the Large size, up to five quick facts from the article's infobox data — born, died, occupation, founded, population, website and the like — where each linkable value (a country, an occupation, a website) is clickable,
   - a **Read in Wikipedia →** link that opens the full article in a new tab.
4. The popup fades away when you click elsewhere, clear the selection, or press Esc.

Redirects (e.g. "USA") don't trigger the popup by default — only exact article titles like "United States" or "Albert Einstein" do (a setting relaxes this). Matching is case-insensitive, mirroring MediaWiki's own title normalization. Disambiguation titles show a "may refer to:" list — click a meaning to preview it in place. If a title doesn't exist in your chosen language edition, English Wikipedia is tried automatically. Lookups never fire inside inputs, textareas, or rich-text editors, results are cached, and all animations respect `prefers-reduced-motion`.

The toolbar button opens a small popup with your recent lookups (stored only on your device) and a search box for looking up titles directly.

## Install

**Chrome / Edge / Brave (unpacked):**

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.
3. Visit any page, select e.g. `Albert Einstein`, and the preview appears.

**Firefox:** grab `wikilens-firefox-<version>.zip` from the [latest release](https://github.com/Ville-Mattila/wikilens/releases) and load it via `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** (a Firefox Add-ons listing is on its way).

Store listings for the Chrome Web Store and Firefox Add-ons are in review.

## Settings

Click the gear in the toolbar popup, or right-click the WikiLens icon → **Options** (opens in its own tab). Settings sync via `chrome.storage.sync` and apply immediately — no reload needed:

- **Wikipedia language** — which Wikipedia edition to search, from 23 choices (default: English). Also used for quick-fact links; English is tried as a fallback.
- **Popup size** — Small, Medium, or Large. Small is compact; Medium and Large share roomier dimensions, and Large additionally shows the quick facts block.
- **Theme** — Light, Dark, or Auto (follows the OS preference). Default: Dark.
- **Trigger** — On select (default), or Alt + select for popups only when you ask.
- **Exact title matches only** — when on (default), the preview appears only if the selection is exactly an article's title. Turn off to also follow Wikipedia redirects, e.g. selecting "USA" previews "United States".
- **Disabled sites** — hostnames (one per line, subdomains included) where WikiLens stays quiet.

## Quick facts, technically

Every Wikipedia article links a Wikidata entity. For the Large popup, the service worker fetches that entity's claims and resolves a curated set of properties (birth/death dates, occupation, nationality, founding date, country, capital, population, website), then resolves item labels and Wikipedia article links in one batch request. Both are anonymous CORS requests to `wikidata.org` — no extra extension permissions. Facts are best-effort: if anything fails, the popup simply appears without them.

## Files

- `manifest.json` — Manifest V3 config; content script on all pages (except Wikipedia itself), host permission for `*.wikipedia.org`, `storage` permission for settings.
- `content.js` — selection tracking, popup rendering (shadow DOM, so page CSS can't interfere), entrance/exit animations, positioning, size/theme application.
- `background.js` — service worker performing the Wikipedia lookup and the Wikidata quick-facts resolution, avoiding page-level CORS/CSP restrictions.
- `options.html` / `options.js` — the settings page.
- `action.html` / `action.js` — the toolbar popup (recent lookups + title search).
- `firefox/manifest.json` — the Firefox (AMO) manifest variant; build with `scripts/package.ps1 -Target firefox`.
- `docs/` — the landing page served by GitHub Pages.
- `store-assets/`, `STORE.md`, `PRIVACY.md`, `scripts/package.ps1` — store submission materials and packaging (Chrome Web Store, Edge Add-ons, Firefox AMO).

## License

WikiLens is free software, released under the [GNU General Public License v3.0](LICENSE).
