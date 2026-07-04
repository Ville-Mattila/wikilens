# Chrome Web Store submission notes

Everything needed to fill in the Developer Dashboard forms.

## Listing

**Name:** WikiLens

**Summary (132 chars max):**
Select any text to instantly preview the matching Wikipedia article — image,
first paragraph, and a link to read more.

**Category:** Productivity → Tools

**Detailed description:**

> WikiLens turns every page into an encyclopedia. Select any text — if it's
> the exact title of a Wikipedia article, a small popup appears right where
> you are, with the article's image, its full first paragraph, and a link to
> read the rest on Wikipedia.
>
> — Exact by default: previews appear only when your selection is precisely
> an article title, so the popup never gets in your way. Prefer looser
> matching? One switch also resolves redirects like "USA" → "United States".
> — 23 languages: point WikiLens at any major Wikipedia edition.
> — Yours to shape: three popup sizes, light and dark themes.
> — Private by design: your selection travels to Wikipedia's API and nowhere
> else. No analytics, no tracking, no accounts. Open source.

**Homepage:** https://ville-mattila.github.io/wikilens/
**Privacy policy URL:** https://github.com/Ville-Mattila/wikilens/blob/main/PRIVACY.md

## Single purpose description

WikiLens has one purpose: showing a Wikipedia article preview for text the
user selects on a web page.

## Permission justifications

Paste these verbatim — both are under the dashboard's 1000-character limit.

**Host permission justification (991 chars):**

> WikiLens has a single purpose: when the user selects text on a page, it
> shows a preview of the matching Wikipedia article. Broad host access is
> required for both halves of this: (1) A content script must run on all
> pages to listen for the user's text-selection gesture and render the
> preview popup next to the selection. It activates only on an explicit
> selection, reads only the selected text, and injects nothing except the
> extension's own popup. activeTab is not viable, as it would require
> clicking the toolbar icon before every lookup, defeating the select-and-see
> purpose. (2) Access to https://*.wikipedia.org/* lets the service worker
> query the Wikipedia REST API (/api/rest_v1/page/summary/) to check the
> selected text against article titles and fetch the summary and thumbnail.
> The subdomain wildcard is needed because each language edition the user can
> choose in settings lives on its own subdomain (en.wikipedia.org,
> fi.wikipedia.org, etc.). No other data is read or transmitted.

**storage justification (452 chars):**

> The storage permission saves the user's preferences via
> chrome.storage.sync: Wikipedia language edition, popup size
> (small/medium/large), light or dark theme, and the exact-title matching
> mode. These settings are read by the service worker and content script to
> render previews the way the user configured, and sync across the user's own
> Chrome profiles. No user data, browsing data, or selected text is ever
> stored - only these four preference values.

## Privacy practices tab answers

- Single purpose: yes (see above).
- Data usage → what user data do you collect?
  - **Website content** (the user's selected text) — transmitted to the
    Wikipedia API solely to look up the matching article. Not collected or
    stored by the developer.
  - Everything else (personally identifiable info, health, financial,
    authentication, communications, location, web history, user activity):
    **not collected**.
- Data is NOT sold to third parties: certify.
- Data is NOT used or transferred for purposes unrelated to the single
  purpose: certify.
- Data is NOT used or transferred to determine creditworthiness or for
  lending purposes: certify.
- Limited Use policy: compliant.

## Packaging

Create the upload ZIP with only the runtime files:

```powershell
powershell -File scripts/package.ps1
```

Produces `dist/wikilens-<version>.zip` containing manifest.json, background.js,
content.js, options.html, options.js, and icons/.

## Store assets

Generated in `store-assets/out/` (see `store-assets/`):

- `screenshot-1.png`, `screenshot-2.png`, `screenshot-3.png` — 1280×800
- `promo-small.png` — 440×280 (small promo tile)
- `promo-marquee.png` — 1400×560 (marquee, optional)
