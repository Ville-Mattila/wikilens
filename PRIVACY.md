# WikiLens Privacy Policy

*Last updated: July 4, 2026*

WikiLens is a browser extension that shows a Wikipedia preview when you select
text on a web page. It is designed to collect as little data as possible —
in practice, none.

## What data WikiLens handles

**Selected text.** When you select text on a page, WikiLens sends that text to
the Wikipedia REST API (`*.wikipedia.org`, operated by the Wikimedia
Foundation) to check whether it matches an article title and to fetch the
article summary. This is the extension's sole purpose and the only data that
ever leaves your browser. The request goes directly from your browser to
Wikipedia — there are no intermediary servers.

**Article identifier (Large popup size only).** When the popup size is set to
Large, WikiLens additionally requests the matched article's public facts
(such as birth date or population) from the Wikidata API (`wikidata.org`,
also operated by the Wikimedia Foundation), using the article's public
Wikidata identifier. No selected text or personal data is included in these
requests.

**Settings.** Your preferences (language, popup size, theme, matching mode)
are stored using Chrome's built-in `chrome.storage.sync`, which may sync them
across your own signed-in Chrome profiles. Settings never leave Google's
Chrome sync infrastructure and are not visible to the developer.

## What WikiLens does NOT do

- No analytics, telemetry, or usage tracking of any kind.
- No data is collected, stored, logged, or transmitted to the developer.
- No data is sold or shared with third parties.
- No cookies are set and no user identifiers are created.
- No browsing history is read or recorded. The extension only reacts to an
  explicit text selection, and only reads the selected text itself.

## Third parties

Wikipedia API requests are subject to the Wikimedia Foundation's privacy
policy: https://foundation.wikimedia.org/wiki/Policy:Privacy_policy

## Open source

The complete source code is available for inspection at
https://github.com/Ville-Mattila/wikilens

## Contact

Questions about this policy: open an issue at
https://github.com/Ville-Mattila/wikilens/issues
