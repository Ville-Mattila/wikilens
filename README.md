# WikiLens

A Chromium extension that shows an instant Wikipedia preview when you select text on any page — but only when the selected text is the exact title of an existing Wikipedia article.

**Landing page & live demo:** https://ville-mattila.github.io/wikilens/

## How it works

1. Select any text on a web page (mouse or keyboard).
2. After a short debounce, the extension asks the English Wikipedia REST API whether the selection is an exact article title.
3. If it is, a small popup appears next to the selection with:
   - the article's thumbnail image (when one exists),
   - the title and the opening snippet,
   - a **Read in Wikipedia →** link that opens the full article in a new tab.
4. The popup disappears when you click elsewhere or clear the selection.

Redirects (e.g. "USA") and disambiguation pages don't trigger the popup — only exact article titles like "United States" or "Albert Einstein" do. Matching is case-insensitive, mirroring MediaWiki's own title normalization.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome/Edge/Brave.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Visit any page, select e.g. `Albert Einstein`, and the preview appears.

## Settings

Right-click the WikiLens icon → **Options** (or open it from the extension's details page in `chrome://extensions`). Settings sync via `chrome.storage.sync` and apply immediately — no reload needed:

- **Wikipedia language** — which Wikipedia edition to search (default: English).
- **Popup size** — Small, Medium, or Large; scales the card width, fonts, image height, and how many snippet lines are shown.
- **Theme** — Light or Dark (default: Dark).
- **Exact title matches only** — when on (default), the preview appears only if the selection is exactly an article's title. Turn off to also follow Wikipedia redirects, e.g. selecting "USA" previews "United States". Disambiguation pages never show a preview.

## Files

- `manifest.json` — Manifest V3 config; content script on all pages (except Wikipedia itself), host permission for `*.wikipedia.org`, `storage` permission for settings.
- `content.js` — selection tracking, popup rendering (shadow DOM, so page CSS can't interfere), positioning near the selection, size/theme application.
- `background.js` — service worker that performs the Wikipedia API lookup, avoiding page-level CORS/CSP restrictions; reads the language setting.
- `options.html` / `options.js` — the settings page (embedded in the extensions UI).
