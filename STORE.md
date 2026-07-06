# Chrome Web Store submission notes

Everything needed to fill in the Developer Dashboard forms.

## Listing

**Name:** WikiLens

**Summary (132 chars max, currently 130):**
Select any text to instantly preview the matching Wikipedia article — images,
first paragraph, quick facts, and a link to read on.

**Category:** Productivity → Tools

**Detailed description:**

> WikiLens turns every page into an encyclopedia. Select any text — if it's
> the exact title of a Wikipedia article, an elegant popup appears right
> where you are: the article's images shown whole (flip through them with an
> arrow), the full first paragraph, and a link to read the rest on Wikipedia.
>
> EXACT BY DEFAULT
> Previews appear only when your selection is precisely an article title, so
> the popup never gets in your way. Ambiguous titles show a tidy "may refer
> to:" list — click a meaning to preview it in place. Prefer looser matching?
> One switch also resolves redirects like "USA" → "United States".
>
> QUICK FACTS
> The Large popup adds up to five facts from the article's infobox — born,
> died, occupation, founded, population, website — each linkable value a
> clickable link of its own.
>
> 23 LANGUAGES
> Point WikiLens at any major Wikipedia edition, with an automatic English
> fallback when a title only exists there.
>
> YOURS TO SHAPE
> Three popup sizes, light/dark/auto themes, an optional Alt+select trigger,
> and a per-site disable list for sites where you want quiet. Esc dismisses;
> nothing triggers while you type in forms or editors. Plays nicely with
> Dark Reader and hover-zoom extensions.
>
> ALWAYS AT HAND
> The toolbar popup keeps your recent lookups nearby (stored only on your
> device) and lets you look up titles directly.
>
> PRIVATE BY DESIGN
> Your selection travels to Wikimedia's APIs (Wikipedia and Wikidata) and
> nowhere else. No analytics, no tracking, no accounts. Free software under
> the GPL-3.0 — source at github.com/Ville-Mattila/wikilens.

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

**storage justification (647 chars):**

> The storage permission saves the user's preferences via
> chrome.storage.sync: Wikipedia language edition, popup size, theme,
> trigger mode, exact-title matching mode, and the user's own list of sites
> where the extension is disabled. It also keeps a device-local list of the
> user's last 10 previewed articles (title and Wikipedia URL) via
> chrome.storage.local, shown in the toolbar popup as recent lookups.
> Nothing is transmitted anywhere: sync values stay within the user's own
> Chrome profile sync, and the recents list never leaves the device. No
> browsing history is recorded - only articles the user explicitly
> previewed by selecting their titles.

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

## Other stores

### Microsoft Edge Add-ons

- [ ] Reuses the **same Chrome zip** — no separate build needed
      (`powershell -File scripts/package.ps1`).
- [ ] Register a free Partner Center account:
      https://partner.microsoft.com/dashboard/microsoftedge/overview
- [ ] Listing fields mirror Chrome's — reuse the same name, summary,
      detailed description, category, screenshots, and privacy policy URL
      from this file.
- [ ] Permission/single-purpose justifications: paste the same text as the
      Chrome submission; Edge review asks for equivalent disclosures.
- [ ] Privacy policy URL: same as Chrome —
      https://github.com/Ville-Mattila/wikilens/blob/main/PRIVACY.md

### Firefox AMO (addons.mozilla.org)

- [ ] Build the Firefox-specific zip:
      `powershell -File scripts/package.ps1 -Target firefox`
      → produces `dist/wikilens-firefox-<version>.zip` using
      `firefox/manifest.json` (background as `scripts`, plus
      `browser_specific_settings.gecko`).
- [ ] Submit at https://addons.mozilla.org/developers/
- [ ] Source code submission is **not required** — there's no build step,
      the uploaded zip already is the source.
- [ ] Listing fields mirror Chrome's — reuse the same name, summary,
      description, and screenshots from this file.
- [ ] Privacy policy URL: same as Chrome —
      https://github.com/Ville-Mattila/wikilens/blob/main/PRIVACY.md
- [ ] Expect an automated review pass first; note the extension only uses
      `storage` + the wikipedia.org host permission, so it should sail
      through.
