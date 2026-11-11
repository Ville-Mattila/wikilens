// WikiLens content script: watches text selection, asks the background
// worker whether it matches an exact Wikipedia article, and shows a
// small preview popup near the selection.

(() => {
  const MAX_TITLE_LENGTH = 80;
  const DEBOUNCE_MS = 180;

  // textMax: the snippet area scrolls once the paragraph exceeds this height.
  // Medium and Large share dimensions; Large additionally shows quick facts.
  const SIZES = {
    small: { width: 325, textMax: 140, title: 14, text: 12 },
    medium: { width: 500, textMax: 280, title: 18, text: 14 },
    large: { width: 500, textMax: 280, title: 18, text: 14 },
  };

  const THEMES = {
    light: {
      bg: "#ffffff",
      text: "#202122",
      border: "#a2a9b1",
      divider: "#eaecf0",
      thumbBg: "#eaecf0",
      link: "#3366cc",
    },
    dark: {
      bg: "#202124",
      text: "#e8eaed",
      border: "#5f6368",
      divider: "#3c4043",
      thumbBg: "#303134",
      link: "#8ab4f8",
    },
  };

  let settings = {
    size: "medium",
    theme: "dark",
    trigger: "select",
    hoverLinks: true,
    disabledSites: [],
  };
  chrome.storage.sync.get(settings, (stored) => {
    settings = {
      size: stored.size,
      theme: stored.theme,
      trigger: stored.trigger,
      hoverLinks: stored.hoverLinks,
      disabledSites: stored.disabledSites,
    };
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.size) settings.size = changes.size.newValue;
    if (changes.theme) settings.theme = changes.theme.newValue;
    if (changes.trigger) settings.trigger = changes.trigger.newValue;
    if (changes.hoverLinks) settings.hoverLinks = changes.hoverLinks.newValue;
    if (changes.disabledSites) settings.disabledSites = changes.disabledSites.newValue;
  });

  let popupHost = null;
  let popupCard = null; // direct reference to the current card element
  let currentArticle = null; // the article object backing the current card
  let debounceTimer = null;
  let requestSeq = 0; // guards against out-of-order async responses

  // Popup-to-popup navigation: each entry is { article, left, top } captured
  // right before an in-place replacement (disambiguation option or fact-link
  // follow). Cleared whenever the popup is dismissed or a fresh selection
  // lookup opens a brand-new popup.
  let historyStack = [];
  let pinned = false; // reading-companion mode: suppresses dismissals/new lookups

  document.addEventListener("mouseup", scheduleLookup);
  document.addEventListener("keyup", (e) => {
    // catch keyboard selections (shift+arrows, ctrl+a on a paragraph, etc.)
    if (e.shiftKey || e.key === "Shift") scheduleLookup(e);
  });
  // True while a pointer interaction (click, drag, text selection) is in
  // progress inside the popup. Pressing the mouse there collapses the page's
  // selection, which would otherwise trip the selectionchange dismissal
  // below — making text inside the popup impossible to select.
  let popupPointerDown = false;

  // How the open popup came to be: "select" (text selection or shortcut),
  // "hover" (resting on a Wikipedia link; closes when the pointer leaves),
  // or "engaged" (a hover popup the user clicked into; now it stays until
  // a click outside or Escape, like a selection popup).
  let popupOrigin = null;

  document.addEventListener("mousedown", (e) => {
    cancelHoverIntent();
    if (popupHost && e.composedPath().includes(popupHost)) {
      popupPointerDown = true;
      if (popupOrigin === "hover") popupOrigin = "engaged";
      return;
    }
    popupPointerDown = false;
    if (popupHost && !pinned) dismissPopup();
  });
  document.addEventListener("mouseup", () => {
    // let the selection settle before re-arming the dismissal
    setTimeout(() => {
      popupPointerDown = false;
    }, 80);
  });
  document.addEventListener("selectionchange", () => {
    if (popupPointerDown) return;
    if (pinned) return;
    // only selection popups live and die with the selection
    if (popupOrigin !== "select") return;
    const sel = document.getSelection();
    if (popupHost && (!sel || sel.isCollapsed)) dismissPopup();
  });
  document.addEventListener("keydown", (e) => {
    // Escape always closes, even while pinned.
    if (e.key === "Escape" && popupHost) dismissPopup();
  });

  // A real dismissal (as opposed to renderPopup's internal teardown-before-
  // rebuild) ends the whole popup session: pin state and navigation history
  // don't carry over to the next selection.
  function dismissPopup() {
    pinned = false;
    historyStack = [];
    popupOrigin = null;
    clearTimeout(hoverHideTimer);
    removePopup();
  }

  // ---- Link hover previews ----
  // Resting the mouse on a link to a Wikipedia article opens the same popup.
  // The popup closes shortly after the pointer leaves both the link and the
  // popup, unless the user clicked into it or pinned it.
  const HOVER_DELAY_MS = 450; // intent delay: passing over a link does nothing
  const HOVER_HIDE_MS = 300; // grace period for crossing the gap to the popup
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  let hoverLink = null; // the page link currently hovered with intent
  let hoverPopupLink = null; // the link the open hover preview belongs to
  let hoverPoint = null; // pointer position, to anchor on the right line
  let hoverSavedTitle = null; // the link's tooltip, hidden while hovering
  let hoverTimer = null;
  let hoverHideTimer = null;

  document.addEventListener("mouseover", (e) => {
    if (popupHost && e.composedPath().includes(popupHost)) {
      clearTimeout(hoverHideTimer); // reached the popup: keep it
      return;
    }
    const link = e.target.closest?.("a[href]");
    if (!link) return;
    if (link === hoverLink) {
      clearTimeout(hoverHideTimer);
      return;
    }
    if (!settings.hoverLinks || !finePointer.matches) return;
    // never replace a pinned popup or one opened by a selection
    if (pinned || (popupHost && popupOrigin !== "hover")) return;
    if (isDisabledSite() || link.isContentEditable) return;
    const target = wikiLinkTarget(link.href);
    if (!target) return;

    // an open preview of a different link still closes on its own timer
    cancelHoverIntent();
    hoverLink = link;
    hoverPoint = { x: e.clientX, y: e.clientY };
    // the native tooltip would sit on top of the preview
    if (link.hasAttribute("title")) {
      hoverSavedTitle = link.getAttribute("title");
      link.removeAttribute("title");
    }
    // back on the link whose preview is still open: just keep it
    if (popupHost && popupOrigin === "hover" && link === hoverPopupLink) {
      clearTimeout(hoverHideTimer);
      return;
    }
    hoverTimer = setTimeout(() => lookupHoveredLink(link, target), HOVER_DELAY_MS);
  });

  document.addEventListener("mouseout", (e) => {
    const to = e.relatedTarget;
    if (popupHost && e.composedPath().includes(popupHost)) {
      if (to && popupHost.contains(to)) return; // moving within the popup
      scheduleHoverHide();
      return;
    }
    if (!hoverLink || !e.composedPath().includes(hoverLink)) return;
    if (to && hoverLink.contains(to)) return; // moving within the link
    cancelHoverIntent();
    scheduleHoverHide();
  });

  function scheduleHoverHide() {
    if (popupOrigin !== "hover") return;
    clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(() => {
      if (popupOrigin === "hover" && !pinned && !popupPointerDown) dismissPopup();
    }, HOVER_HIDE_MS);
  }

  // Forgets the hovered link: stops a pending lookup and gives the link
  // its tooltip back.
  function cancelHoverIntent() {
    clearTimeout(hoverTimer);
    if (hoverLink && hoverSavedTitle !== null) {
      hoverLink.setAttribute("title", hoverSavedTitle);
    }
    hoverLink = null;
    hoverSavedTitle = null;
  }

  function lookupHoveredLink(link, target) {
    const seq = ++requestSeq;
    chrome.runtime.sendMessage(
      { type: "wikilens-lookup", title: target.title, lang: target.lang, exact: false },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (seq !== requestSeq) return;
        if (!response?.ok) return;
        if (hoverLink !== link || !link.isConnected) return; // pointer moved on
        if (pinned || (popupHost && popupOrigin !== "hover")) return;
        const rect = hoveredLineRect(link);
        if (!rect) return;
        renderPopup(response.data, { rect });
        popupOrigin = "hover";
        hoverPopupLink = link;
      }
    );
  }

  // A link that wraps across lines has one box per line; anchor the popup
  // to the line under the pointer rather than the whole wrapped block.
  function hoveredLineRect(link) {
    const rects = [...link.getClientRects()].filter((r) => r.width && r.height);
    if (!rects.length) return null;
    if (hoverPoint) {
      const hit = rects.find(
        (r) => hoverPoint.y >= r.top && hoverPoint.y <= r.bottom
      );
      if (hit) return hit;
    }
    return rects[0];
  }

  // The background worker sends this when the user presses the keyboard
  // shortcut. An explicit command bypasses the trigger-mode/Alt gate, the
  // disabled-sites gate, and the editable-context gate — the user's intent
  // is unambiguous — but still respects getSelectedTitle()'s constraints.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "wikilens-trigger") {
      runLookup({ force: true });
    } else if (message?.type === "wikilens-enrich") {
      applyEnrichment(message);
    }
  });

  // The background answers with the core article first (fast) and streams
  // facts/images/audio afterwards. Patch them into the open popup, but only
  // if it still shows the lookup they belong to.
  function applyEnrichment({
    lookupId, facts, images, audioUrl, fullExtractHtml, sections,
  }) {
    if (!popupHost || !popupCard || !currentArticle) return;
    if (currentArticle.disambiguation || currentArticle.sectionView) return;
    if (currentArticle.lookupId !== lookupId) return;

    currentArticle.facts = facts;
    currentArticle.images = images;
    currentArticle.audioUrl = audioUrl;
    if (fullExtractHtml) currentArticle.fullExtractHtml = fullExtractHtml;
    if (sections) currentArticle.sections = sections;
    const card = popupCard;

    // Grow the first paragraph into the whole lead section, but never
    // yank content out from under a reader who has already scrolled.
    const extract = card.querySelector(".extract");
    if (fullExtractHtml) {
      if (extract && extract.scrollTop === 0) {
        extract.replaceChildren();
        renderFormattedText(extract, fullExtractHtml, wikiBaseUrl(currentArticle));
      }
    }
    extract?._wlFadeUpdate?.(); // content may have grown past the cap

    if (sections?.length && !card.querySelector(".sections")) {
      const anchor =
        card.querySelector(".facts") ?? card.querySelector(".footer");
      card.insertBefore(buildSectionsBlock(currentArticle), anchor);
    }

    if (images?.length > 1 && !card.querySelector(".imgnav")) {
      const newWrap = buildImageCarousel(images, currentArticle.title);
      const oldWrap = card.querySelector(".thumbwrap");
      if (oldWrap) {
        oldWrap.replaceWith(newWrap);
      } else {
        card.insertBefore(newWrap, card.firstChild);
      }
    }
    if (facts?.length && !card.querySelector(".facts")) {
      const footer = card.querySelector(".footer");
      card.insertBefore(buildFactsBlock(facts), footer);
    }
    if (audioUrl && !card.querySelector(".audio-btn")) {
      card.querySelector(".title")?.appendChild(buildAudioButton(audioUrl));
    }
    if (isDarkReaderActive() && popupHost.shadowRoot) {
      const theme = THEMES[resolveThemeName()] ?? THEMES.dark;
      hardenAgainstRecoloring(popupHost.shadowRoot, card, theme);
    }
  }

  function scheduleLookup(event) {
    if (popupHost && event.composedPath?.().includes(popupHost)) return;
    if (pinned) return; // popup is a pinned reading companion; leave it alone
    if (settings.trigger === "alt" && !event.altKey) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runLookup(), DEBOUNCE_MS);
  }

  function runLookup(options = {}) {
    const { force = false } = options;
    if (!force) {
      if (isEditableContext()) return;
      if (isDisabledSite()) return;
    }
    const text = getSelectedTitle();
    if (!text) return;

    const seq = ++requestSeq;
    chrome.runtime.sendMessage(
      { type: "wikilens-lookup", title: text },
      (response) => {
        if (chrome.runtime.lastError) return; // worker asleep/errored — no popup
        if (seq !== requestSeq) return; // a newer selection superseded this one
        if (!response?.ok) return; // not an exact article title
        if (getSelectedTitle() !== text) return; // selection changed meanwhile
        showPopup(response.data);
      }
    );
  }

  function resolveThemeName() {
    if (settings.theme === "auto") {
      return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return settings.theme;
  }

  function isDarkReaderActive() {
    return (
      document.documentElement.hasAttribute("data-darkreader-mode") ||
      !!document.querySelector("style.darkreader, meta[name='darkreader']")
    );
  }

  // Dark Reader mangles the popup: it half-recolors our shadow content
  // (light text on our light background) and ignores darkreader-lock in
  // shadow roots. Two-layer defense: (1) remove any stylesheet it injects
  // into our shadow root, now and on every later attempt; (2) pin the
  // palette as inline !important declarations, which outrank stylesheet
  // !important rules in the cascade — nothing injected can override them.
  let darkReaderObserver = null; // disconnected in removePopup

  function hardenAgainstRecoloring(shadow, card, theme) {
    darkReaderObserver?.disconnect(); // idempotent: re-run after enrichment
    const strip = () =>
      shadow.querySelectorAll("style.darkreader").forEach((s) => s.remove());
    strip();
    darkReaderObserver = new MutationObserver(strip);
    darkReaderObserver.observe(shadow, { childList: true });

    const pin = (el, props) => {
      for (const [prop, value] of Object.entries(props)) {
        el.style.setProperty(prop, value, "important");
      }
    };
    pin(card, {
      background: theme.bg,
      color: theme.text,
      "border-color": theme.border,
    });
    const pinAll = (selector, props) =>
      card.querySelectorAll(selector).forEach((el) => pin(el, props));
    pinAll(".thumb", { background: theme.thumbBg });
    pinAll(".title, .extract, .subtitle, .option, .facts .fv", {
      color: theme.text,
    });
    pinAll(".facts, .footer, .sections", { "border-color": theme.divider });
    pinAll(".facts .fl, .link, .sections .sl", { color: theme.link });
    pinAll(".facts .fv a", { color: theme.text });
    pinAll(".extract a", {
      color: theme.text,
      "border-color": theme.border,
    });
    pinAll(".sections a", {
      color: theme.text,
      background: "transparent",
      "border-color": theme.divider,
    });
    pinAll(".fadeout", {
      "background-image": `linear-gradient(to bottom, transparent, ${theme.bg})`,
    });
    pinAll(".imgnav, .imgcount", {
      background: "rgba(0, 0, 0, 0.45)",
      color: "#ffffff",
    });
    pinAll(".tbtn", { color: theme.text, background: "transparent" });
    pinAll(".tbtn.pin.on", { color: "#ffffff", background: theme.link });
    pinAll(".audio-btn", { color: theme.link, background: "transparent" });
  }

  function isDisabledSite() {
    const host = location.hostname.toLowerCase();
    return settings.disabledSites.some(
      (entry) => host === entry || host.endsWith("." + entry)
    );
  }

  function isEditableContext() {
    const active = document.activeElement;
    if (active) {
      const tag = active.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || active.isContentEditable) {
        return true;
      }
    }
    const sel = document.getSelection();
    const anchor = sel?.anchorNode;
    if (!anchor) return false;
    // anchorNode may be a text node; closest() needs an element
    const el = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
    return !!el?.closest?.('input, textarea, [contenteditable]:not([contenteditable="false"])');
  }

  function getSelectedTitle() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    if (!text || text.length > MAX_TITLE_LENGTH) return null;
    if (/[\n\r\t]/.test(text)) return null; // multi-line selections aren't titles
    return text;
  }

  function selectionRect() {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return rect;
  }

  function showPopup(article) {
    const rect = selectionRect();
    if (!rect) return;
    cancelHoverIntent(); // a selection takes over from any pending hover
    renderPopup(article, { rect });
    popupOrigin = "select";
  }

  // Renders a popup either anchored to the current selection rect, or at a
  // fixed page position (left/top, already including scroll offset) — used
  // when replacing a disambiguation card with an article card after an
  // option click, at which point the original selection may be gone.
  function renderPopup(article, position) {
    removePopup(false); // replace instantly, no exit animation overlap

    // A rect-anchored popup is a brand-new, selection-driven session (fresh
    // lookup or forced keyboard trigger) rather than an in-place
    // replacement, so it starts a clean navigation/pin state. In-place
    // replacements (disambiguation options, fact links, the back button)
    // pass {left, top} and must NOT wipe the stack they're built on.
    if (position.rect) {
      historyStack = [];
      pinned = false;
    }
    currentArticle = article;

    popupHost = document.createElement("div");
    popupHost.style.cssText =
      "position:absolute;z-index:2147483647;width:0;height:0;";
    // in-place replacements while pinned keep the viewport-fixed mode
    if (pinned) popupHost.style.position = "fixed";
    // "open" so other extensions (hover-zoom tools etc.) can see the popup's
    // contents via composedPath()/shadowRoot; style isolation is unaffected
    const shadow = popupHost.attachShadow({ mode: "open" });

    const size = SIZES[settings.size] ?? SIZES.medium;
    const theme = THEMES[resolveThemeName()] ?? THEMES.dark;

    const style = document.createElement("style");
    style.textContent = `
      .card {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        display: block;
        width: ${size.width}px;
        background: ${theme.bg};
        color: ${theme.text};
        border: 1px solid ${theme.border};
        border-radius: 16px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        overflow: hidden;
        transform-origin: 50% 0;
        animation: wl-pop 0.42s cubic-bezier(0.34, 1.56, 0.64, 1) backwards;
      }
      .card.out {
        animation: wl-out 0.18s ease-in forwards;
      }
      @keyframes wl-pop {
        from { opacity: 0; transform: translateY(14px) scale(0.92); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes wl-out {
        to { opacity: 0; transform: translateY(8px) scale(0.96); }
      }
      @keyframes wl-rise {
        from { opacity: 0; transform: translateY(7px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      @keyframes wl-settle {
        from { transform: scale(1.1); }
        to   { transform: scale(1); }
      }
      .thumbwrap {
        position: relative;
        overflow: hidden;
      }
      .thumb {
        display: block;
        width: 100%;
        height: auto;
        /* never crop: natural aspect ratio, tall images letterbox at the cap */
        max-height: 420px;
        object-fit: contain;
        background: ${theme.thumbBg};
        animation: wl-settle 0.9s cubic-bezier(0.22, 1, 0.36, 1) backwards;
        transition: opacity 0.16s ease;
      }
      .thumb.fade { opacity: 0; }
      .imgnav {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        width: 30px;
        height: 30px;
        border: none;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.45);
        color: #fff;
        font-size: 18px;
        line-height: 28px;
        text-align: center;
        padding: 0;
        cursor: pointer;
        transition: background 0.15s, transform 0.15s;
      }
      .imgnav:hover {
        background: rgba(0, 0, 0, 0.7);
        transform: translateY(-50%) scale(1.08);
      }
      .imgcount {
        position: absolute;
        right: 8px;
        bottom: 8px;
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.45);
        color: #fff;
        pointer-events: none;
      }
      .title { animation: wl-rise 0.38s 0.1s cubic-bezier(0.22, 1, 0.36, 1) backwards; }
      .extract { animation: wl-rise 0.38s 0.17s cubic-bezier(0.22, 1, 0.36, 1) backwards; }
      .facts { animation: wl-rise 0.38s 0.24s cubic-bezier(0.22, 1, 0.36, 1) backwards; }
      .footer { animation: wl-rise 0.38s 0.3s cubic-bezier(0.22, 1, 0.36, 1) backwards; }
      .facts {
        border-top: 1px solid ${theme.divider};
        padding: 10px 14px 12px;
        display: grid;
        grid-template-columns: auto 1fr;
        column-gap: 14px;
        row-gap: 4px;
        font-size: ${size.text - 1}px;
        line-height: 1.45;
      }
      .facts .fl {
        color: ${theme.link};
        font-weight: 600;
        text-transform: uppercase;
        font-size: ${size.text - 3}px;
        letter-spacing: 0.05em;
        padding-top: 1px;
      }
      .facts .fv { min-width: 0; }
      .facts .fv a {
        color: inherit;
        text-decoration: underline;
        text-decoration-color: ${theme.border};
        text-underline-offset: 2px;
        transition: color 0.15s, text-decoration-color 0.15s;
      }
      .facts .fv a:hover {
        color: ${theme.link};
        text-decoration-color: ${theme.link};
      }
      @media (prefers-reduced-motion: reduce) {
        .card, .card.out, .thumb, .title, .extract, .facts, .sections,
        .footer { animation: none; }
      }
      .body { padding: 12px 14px 10px; }
      .title {
        font-size: ${size.title}px;
        font-weight: 700;
        margin: 0 0 6px;
        font-family: Georgia, "Times New Roman", serif;
      }
      .extract {
        font-size: ${size.text}px;
        line-height: 1.5;
        margin: 0;
        max-height: ${size.textMax}px;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding-right: 6px;
        scrollbar-width: thin;
        scrollbar-color: ${theme.border} transparent;
      }
      .extract::-webkit-scrollbar {
        width: 6px;
      }
      .extract::-webkit-scrollbar-thumb {
        background: ${theme.border};
        border-radius: 3px;
      }
      .extract::-webkit-scrollbar-track {
        background: transparent;
      }
      .extract p { margin: 0 0 8px; }
      .extract p:last-child { margin-bottom: 0; }
      .extract ul, .extract ol { margin: 0 0 8px; padding-left: 20px; }
      .extract li { margin: 0 0 4px; }
      /* body links stay quiet: text-colored with a faint dotted underline,
         waking up to the link color on hover */
      .extract a {
        color: inherit;
        text-decoration: none;
        border-bottom: 1px dotted ${theme.border};
      }
      .extract a:hover {
        color: ${theme.link};
        border-bottom-color: ${theme.link};
      }
      .extract h3, .extract h4 {
        font-size: ${size.text + 1}px;
        font-weight: 700;
        margin: 10px 0 6px;
      }
      .extractwrap { position: relative; }
      /* a soft fade at the text's lower edge while there is more to read */
      .fadeout {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 26px;
        background: linear-gradient(to bottom, transparent, ${theme.bg});
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.25s ease;
      }
      .sections {
        border-top: 1px solid ${theme.divider};
        padding: 10px 14px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        animation: wl-rise 0.38s 0.27s cubic-bezier(0.22, 1, 0.36, 1) backwards;
      }
      .sections .sl {
        font-size: ${size.text - 3}px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: ${theme.link};
        margin-right: 2px;
      }
      .sections a {
        font-size: ${size.text - 2}px;
        color: ${theme.text};
        opacity: 0.85;
        text-decoration: none;
        border: 1px solid ${theme.divider};
        border-radius: 999px;
        padding: 2px 9px;
        transition: color 0.15s, border-color 0.15s, opacity 0.15s;
      }
      .sections a:hover {
        color: ${theme.link};
        border-color: ${theme.link};
        opacity: 1;
      }
      .footer {
        border-top: 1px solid ${theme.divider};
        padding: 8px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .toolbar {
        display: inline-flex;
        gap: 2px;
        flex: none;
      }
      .tbtn {
        width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        background: transparent;
        border: none;
        border-radius: 6px;
        color: ${theme.text};
        opacity: 0.7;
        font-size: 14px;
        line-height: 1;
        padding: 0;
        margin: 0;
        cursor: pointer;
        transition: background-color 0.15s, opacity 0.15s;
      }
      .tbtn:hover {
        background: ${theme.divider};
        opacity: 1;
      }
      .tbtn.pin.on {
        background: ${theme.link};
        color: #ffffff;
        opacity: 1;
      }
      .tbtn.grip {
        cursor: grab;
      }
      .tbtn.grip.dragging {
        cursor: grabbing;
      }
      .audio-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-left: 6px;
        width: 20px;
        height: 20px;
        border: none;
        background: transparent;
        color: ${theme.link};
        font-size: 13px;
        line-height: 1;
        padding: 0;
        cursor: pointer;
        vertical-align: middle;
      }
      .audio-btn:disabled {
        opacity: 0.4;
        cursor: default;
      }
      .link {
        font-size: ${size.text}px;
        font-weight: 600;
        color: ${theme.link};
        text-decoration: none;
        cursor: pointer;
      }
      .link:hover { text-decoration: underline; }
      .link .arr {
        display: inline-block;
        transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .link:hover .arr { transform: translateX(4px); }
      .subtitle {
        font-size: ${size.text - 1}px;
        color: ${theme.text};
        opacity: 0.7;
        margin: 0 0 8px;
      }
      .options {
        border-top: 1px solid ${theme.divider};
        padding: 6px;
        max-height: ${size.textMax + 40}px;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        scrollbar-color: ${theme.border} transparent;
      }
      .options::-webkit-scrollbar { width: 6px; }
      .options::-webkit-scrollbar-thumb {
        background: ${theme.border};
        border-radius: 3px;
      }
      .options::-webkit-scrollbar-track { background: transparent; }
      .option {
        display: block;
        width: 100%;
        box-sizing: border-box;
        text-align: left;
        font: inherit;
        font-size: ${size.text}px;
        color: ${theme.text};
        background: none;
        border: none;
        border-radius: 6px;
        padding: 8px 8px;
        margin: 0;
        cursor: pointer;
        transition: background-color 0.15s;
      }
      .option:hover, .option:focus-visible {
        background: ${theme.divider};
        outline: none;
      }
    `;
    shadow.appendChild(style);

    const card = article.disambiguation
      ? buildDisambiguationCard(article)
      : buildArticleCard(article);

    shadow.appendChild(card);
    popupCard = card;
    if (isDarkReaderActive()) hardenAgainstRecoloring(shadow, card, theme);
    document.documentElement.appendChild(popupHost);

    // scale the whole card down proportionally when the viewport is
    // narrower than the card (zoom scales layout without touching the
    // entrance animation's transform)
    const baseWidth = (SIZES[settings.size] ?? SIZES.medium).width;
    const scale = Math.min(1, (window.innerWidth - 24) / baseWidth);
    if (scale < 1) card.style.zoom = scale;

    if (position.rect) {
      positionPopup(card, position.rect, baseWidth * scale);
      // the card grows once the image arrives; re-run the placement so a
      // tall image doesn't push the card past the viewport bottom
      const firstImg = card.querySelector("img.thumb");
      if (firstImg && !firstImg.complete) {
        firstImg.addEventListener(
          "load",
          () => {
            if (popupCard === card) {
              positionPopup(card, position.rect, baseWidth * scale);
            }
          },
          { once: true }
        );
      }
    } else {
      // position.left/top are page coordinates; a pinned (fixed) host needs
      // them translated into viewport coordinates
      const left = pinned ? position.left - window.scrollX : position.left;
      const top = pinned ? position.top - window.scrollY : position.top;
      popupHost.style.left = `${left}px`;
      popupHost.style.top = `${top}px`;
    }
  }

  // Builds the normal article card: image, title, extract, optional facts
  // grid, and a footer link to the source page.
  function buildArticleCard(article) {
    const card = document.createElement("div");
    card.className = "card";

    const images = article.images?.length
      ? article.images
      : article.thumbnail
        ? [article.thumbnail]
        : [];
    if (images.length) {
      card.appendChild(buildImageCarousel(images, article.title));
    }

    const body = document.createElement("div");
    body.className = "body";
    const title = document.createElement("p");
    title.className = "title";
    title.appendChild(document.createTextNode(article.title));
    if (typeof article.audioUrl === "string" && article.audioUrl) {
      title.appendChild(buildAudioButton(article.audioUrl));
    }
    let subtitle = null;
    if (article.subtitle) {
      subtitle = document.createElement("p");
      subtitle.className = "subtitle";
      subtitle.textContent = article.subtitle;
    }
    const extract = document.createElement("div");
    extract.className = "extract";
    const bodyHtml = article.fullExtractHtml ?? article.extractHtml;
    if (bodyHtml) {
      renderFormattedText(extract, bodyHtml, wikiBaseUrl(article));
    } else {
      extract.textContent = article.extract;
    }
    const extractWrap = document.createElement("div");
    extractWrap.className = "extractwrap";
    const fade = document.createElement("div");
    fade.className = "fadeout";
    extractWrap.append(extract, fade);
    attachScrollFade(extract, fade);
    if (subtitle) {
      body.append(title, subtitle, extractWrap);
    } else {
      body.append(title, extractWrap);
    }
    card.appendChild(body);

    if (article.sections?.length) {
      card.appendChild(buildSectionsBlock(article));
    }
    if (article.facts?.length) {
      card.appendChild(buildFactsBlock(article.facts));
    }

    card.appendChild(buildFooter(article.pageUrl, { article, showCopy: true }));
    return card;
  }

  // The image area with its carousel controls. Used when building a card
  // and again when enrichment upgrades a single-image card to an album.
  function buildImageCarousel(images, titleText) {
    const wrap = document.createElement("div");
    wrap.className = "thumbwrap";
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = images[0];
    img.alt = titleText;
    wrap.appendChild(img);

    if (images.length > 1) {
      let index = 0;
      let lastWheel = 0;
      const counter = document.createElement("span");
      counter.className = "imgcount";
      counter.textContent = `1 / ${images.length}`;

      const step = (dir) => {
        index = (index + dir + images.length) % images.length;
        counter.textContent = `${index + 1} / ${images.length}`;
        img.classList.add("fade");
        setTimeout(() => {
          img.src = images[index];
          const unfade = () => img.classList.remove("fade");
          img.onload = unfade;
          // a failed load must not leave the image stuck invisible
          img.onerror = unfade;
        }, 160);
        // warm the cache for the next frame in the same direction
        new Image().src = images[(index + dir + images.length) % images.length];
      };

      const next = document.createElement("button");
      next.type = "button";
      next.className = "imgnav";
      next.textContent = "›";
      next.title = "Next image";
      // preserve the text selection, same as the disambiguation options —
      // otherwise the selectionchange handler dismisses the popup
      next.addEventListener("mousedown", (e) => e.preventDefault());
      next.addEventListener("click", () => step(1));

      // mouse wheel over the image flips through the album; down = next,
      // up = previous. Non-passive so the page doesn't scroll underneath,
      // and rate-limited so trackpad wheel streams step one at a time.
      wrap.addEventListener(
        "wheel",
        (e) => {
          if (e.deltaY === 0) return;
          e.preventDefault();
          const now = Date.now();
          if (now - lastWheel < 250) return;
          lastWheel = now;
          step(e.deltaY > 0 ? 1 : -1);
        },
        { passive: false }
      );

      wrap.append(next, counter);
      new Image().src = images[1]; // first step should be instant
    }
    return wrap;
  }

  // Shows the bottom fade only while there is more text to scroll to,
  // updating live as the reader scrolls or the content grows.
  function attachScrollFade(extract, fade) {
    const update = () => {
      const more =
        extract.scrollHeight - extract.scrollTop - extract.clientHeight > 4;
      fade.style.opacity = more ? "1" : "0";
    };
    extract.addEventListener("scroll", update, { passive: true });
    extract._wlFadeUpdate = update; // enrichment re-checks after growth
    requestAnimationFrame(update);
  }

  // "In this article": the article's top-level sections as chips. A plain
  // click opens the section right in the popup; Ctrl/Cmd/Shift-click (or a
  // section we can't fetch) falls back to Wikipedia in a new tab.
  function buildSectionsBlock(article) {
    const block = document.createElement("div");
    block.className = "sections";
    const label = document.createElement("span");
    label.className = "sl";
    label.textContent = "In this article";
    block.appendChild(label);
    const basePageUrl = article.basePageUrl ?? article.pageUrl;
    for (const section of article.sections) {
      const a = document.createElement("a");
      a.href = `${basePageUrl}#${section.anchor}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = section.title;
      if (section.index) {
        a.addEventListener("mousedown", (e) => e.preventDefault());
        a.addEventListener("click", (e) => {
          if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
          e.preventDefault();
          loadSection(article, section, a);
        });
      }
      block.appendChild(a);
    }
    return block;
  }

  // Fetches a section's content and shows it in the popup as a section
  // view: same card, section name as the subtitle, chips still available
  // for hopping onward, back button returning here. If the fetch fails the
  // chip opens Wikipedia instead, so the click never dies silently.
  function loadSection(article, section, chip) {
    if (!popupHost) return;
    const { left, top } = currentPopupPagePosition();
    const fromArticle = currentArticle;
    chip.style.opacity = "0.5";

    const seq = ++requestSeq;
    chrome.runtime.sendMessage(
      {
        type: "wikilens-section",
        pageTitle: article.title,
        index: section.index,
        lang: article.lang ?? "en",
      },
      (response) => {
        chip.style.opacity = "";
        if (chrome.runtime.lastError) return;
        if (seq !== requestSeq) return;
        if (!response?.ok) {
          window.open(chip.href, "_blank", "noopener");
          return;
        }
        const basePageUrl = article.basePageUrl ?? article.pageUrl;
        const sectionArticle = {
          sectionView: true,
          title: article.title,
          subtitle: section.title,
          extractHtml: response.html,
          sections: article.sections,
          lang: article.lang,
          lookupId: article.lookupId,
          basePageUrl,
          pageUrl: `${basePageUrl}#${section.anchor}`,
        };
        if (fromArticle) historyStack.push({ article: fromArticle, left, top });
        renderPopup(sectionArticle, { left, top });
      }
    );
  }

  // The quick-facts grid. Used when building a card and again when
  // enrichment delivers facts to an already open popup.
  function buildFactsBlock(factList) {
    const facts = document.createElement("div");
    facts.className = "facts";
    for (const fact of factList) {
      const label = document.createElement("span");
      label.className = "fl";
      label.textContent = fact.label;
      const value = document.createElement("span");
      value.className = "fv";
      fact.parts.forEach((part, i) => {
        if (i > 0) value.appendChild(document.createTextNode(", "));
        if (part.href) {
          const a = document.createElement("a");
          a.href = part.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = part.text;
          // wiki article links are followed in-place inside the popup;
          // everything else (e.g. the Website fact) opens a new tab as usual
          if (isWikiArticleHref(part.href)) {
            a.addEventListener("click", (e) => handleFactLinkClick(e, a));
          }
          value.appendChild(a);
        } else {
          value.appendChild(document.createTextNode(part.text));
        }
      });
      facts.append(label, value);
    }
    return facts;
  }

  // Builds the disambiguation variant: header + subtitle, a list of
  // tappable option rows, and a footer that still links to the
  // disambiguation page itself. No image, no facts.
  function buildDisambiguationCard(article) {
    const card = document.createElement("div");
    card.className = "card";

    const body = document.createElement("div");
    body.className = "body";
    const title = document.createElement("p");
    title.className = "title";
    title.textContent = article.title;
    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = article.intro || "may refer to:";
    body.append(title, subtitle);
    card.appendChild(body);

    const options = document.createElement("div");
    options.className = "options";
    for (const optionTitle of article.options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option";
      btn.textContent = optionTitle;
      // without this, mousedown collapses the page's text selection, the
      // selectionchange handler dismisses the popup, and the click never runs
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => selectDisambiguationOption(optionTitle));
      options.appendChild(btn);
    }
    card.appendChild(options);

    card.appendChild(buildFooter(article.pageUrl, { showCopy: false }));
    return card;
  }

  // Renders Wikipedia's extract_html into a target element through a strict
  // whitelist: only inline formatting tags and paragraphs survive, with all
  // attributes dropped; anything else is unwrapped to its text content.
  // Remote HTML never reaches innerHTML.
  const FORMAT_TAGS = new Set([
    "B", "I", "EM", "STRONG", "SUB", "SUP", "SPAN", "P",
    "UL", "OL", "LI", "H3", "H4",
  ]);
  // Wikipedia chrome that must vanish entirely (not even as text): edit
  // links, citation markers, reference lists, boxes, tables, media.
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "LINK", "TABLE", "FIGURE", "IMG", "H2",
  ]);
  const SKIP_CLASSES =
    /(^|\s)(mw-editsection|reference|references|noprint|navbox|hatnote|infobox|thumb|gallery|metadata|mw-empty-elt|coordinates|ambox|sidebar)(\s|$)/;

  function renderFormattedText(target, html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    (function walk(srcParent, dstParent) {
      for (const node of srcParent.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          dstParent.appendChild(document.createTextNode(node.nodeValue));
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS.has(node.tagName)) continue;
          if (SKIP_CLASSES.test(node.className?.baseVal ?? node.className ?? "")) continue;
          // placeholder paragraphs with no text would add phantom margins
          if (node.tagName === "P" && !node.textContent.trim()) continue;
          if (node.tagName === "A") {
            // keep article links: absolute against the source wiki,
            // http(s) only, opening Wikipedia in a new tab. Anything else
            // (fragments, odd schemes) unwraps to plain text.
            const href = node.getAttribute("href") ?? "";
            let absolute = null;
            if (baseUrl && href && !href.startsWith("#")) {
              try {
                const url = new URL(href, baseUrl);
                if (url.protocol === "https:" || url.protocol === "http:") {
                  absolute = url.href;
                }
              } catch {
                // unresolvable href: fall through to plain text
              }
            }
            if (absolute) {
              const a = document.createElement("a");
              a.href = absolute;
              a.target = "_blank";
              a.rel = "noopener noreferrer";
              // wiki article links preview in the popup, like fact links;
              // modifier clicks and non-article links keep the new tab
              if (isWikiArticleHref(absolute)) {
                a.addEventListener("mousedown", (e) => e.preventDefault());
                a.addEventListener("click", (e) => handleFactLinkClick(e, a));
              }
              dstParent.appendChild(a);
              walk(node, a);
            } else {
              walk(node, dstParent);
            }
            continue;
          }
          if (FORMAT_TAGS.has(node.tagName)) {
            const el = document.createElement(node.tagName.toLowerCase());
            dstParent.appendChild(el);
            walk(node, el);
          } else {
            walk(node, dstParent);
          }
        }
      }
    })(doc.body, target);
  }

  function wikiBaseUrl(article) {
    return `https://${article?.lang ?? "en"}.wikipedia.org`;
  }

  // Builds a toolbar button consistent with the others: square, transparent,
  // dimmed theme-text color, themed hover background. mousedown is always
  // prevented so clicking it never collapses the page's text selection
  // (same reasoning as the existing option/imgnav buttons).
  function buildToolbarButton(className, label, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `tbtn ${className}`;
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", onClick);
    return btn;
  }

  // opts: { article, showCopy } — article is required to build the copy
  // button (and is always available for the article card); the
  // disambiguation card omits copy/audio entirely by passing showCopy:false.
  function buildFooter(pageUrl, opts = {}) {
    const { article, showCopy = false } = opts;
    const footer = document.createElement("div");
    footer.className = "footer";

    const toolbar = document.createElement("span");
    toolbar.className = "toolbar";

    if (historyStack.length) {
      toolbar.appendChild(
        buildToolbarButton("back", "←", "Back", goBack)
      );
    }

    const pinBtn = buildToolbarButton(
      "pin" + (pinned ? " on" : ""),
      "⏍",
      pinned ? "Unpin popup" : "Pin popup",
      () => {
        pinned = !pinned;
        pinBtn.classList.toggle("on", pinned);
        pinBtn.title = pinned ? "Unpin popup" : "Pin popup";
        applyPinMode();
      }
    );
    toolbar.appendChild(pinBtn);

    // the grip drives the drag from mousedown itself (not click), so it's
    // built by hand rather than through buildToolbarButton
    const gripBtn = document.createElement("button");
    gripBtn.type = "button";
    gripBtn.className = "tbtn grip";
    gripBtn.textContent = "⠿";
    gripBtn.title = "Drag popup";
    gripBtn.addEventListener("mousedown", (e) => {
      e.preventDefault(); // protect the page's text selection
      startDrag(e, gripBtn);
    });
    toolbar.appendChild(gripBtn);

    if (showCopy && article) {
      const copyBtn = buildToolbarButton("copy", "⧉", "Copy citation", () =>
        copyCitation(article, copyBtn)
      );
      toolbar.appendChild(copyBtn);
    }

    footer.appendChild(toolbar);

    const link = document.createElement("a");
    link.className = "link";
    link.href = pageUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Read in Wikipedia ";
    const arr = document.createElement("span");
    arr.className = "arr";
    arr.textContent = "→";
    link.appendChild(arr);
    footer.appendChild(link);
    return footer;
  }

  // Clicking a disambiguation option looks up that title directly.
  function selectDisambiguationOption(optionTitle) {
    navigateInPlace(optionTitle);
  }

  // Returns true for hrefs that point at a Wikipedia article (any language
  // subdomain) rather than an arbitrary external site (e.g. the Website
  // fact), so only the former gets intercepted for in-place navigation.
  function isWikiArticleHref(href) {
    try {
      return new URL(href, location.href).pathname.includes("/wiki/");
    } catch {
      return false;
    }
  }

  // Pages that aren't articles (files, categories, talk, help...). English
  // names only; other languages' namespaces simply fail the lookup quietly.
  const NON_ARTICLE_NAMESPACE =
    /^(special|file|image|media|category|talk|user|wikipedia|wp|help|portal|template|module|draft|mediawiki|timedtext|[a-z ]+ talk):/i;

  // Parses a Wikipedia article URL (any language, desktop or mobile) into
  // { title, lang }, or null for anything else. The title is the path
  // segment after "/wiki/", percent-decoded, with underscores turned back
  // into spaces (Wikipedia's own title <-> URL convention).
  function wikiLinkTarget(href) {
    if (typeof href !== "string") return null; // SVG links carry objects
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname
      .toLowerCase()
      .match(/^([a-z][a-z0-9-]{1,15})(?:\.m)?\.wikipedia\.org$/);
    if (!host || host[1] === "www") return null;
    if (!url.pathname.startsWith("/wiki/")) return null;
    let title;
    try {
      title = decodeURIComponent(url.pathname.slice(6)).replace(/_/g, " ").trim();
    } catch {
      return null;
    }
    if (!title || title.length > 255 || NON_ARTICLE_NAMESPACE.test(title)) {
      return null;
    }
    return { title, lang: host[1] };
  }

  // Plain left-clicks on a wiki fact link navigate the popup in place;
  // ctrl/cmd/shift-clicks (and middle-clicks, which never fire "click")
  // keep the browser's normal open-in-new-tab behavior, as do links to
  // non-article pages.
  function handleFactLinkClick(e, a) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = wikiLinkTarget(a.href);
    if (!target) return;
    e.preventDefault();
    navigateInPlace(target.title, a.href, target.lang);
  }

  // Shared in-place navigation used by both disambiguation options and wiki
  // fact links: looks up `title`, and on success re-renders at the popup's
  // current position, pushing the article that was showing onto the history
  // stack first so the back button can return to it. On failure the current
  // card is left as-is (no request in flight to undo). A link's `lang`
  // targets that link's wiki and follows redirects, like a hovered link.
  function navigateInPlace(title, fallbackHref = null, lang = null) {
    if (!popupHost) return;
    const { left, top } = currentPopupPagePosition();
    const fromArticle = currentArticle;

    const seq = ++requestSeq;
    const message = { type: "wikilens-lookup", title };
    if (lang) Object.assign(message, { lang, exact: false });
    chrome.runtime.sendMessage(
      message,
      (response) => {
        if (chrome.runtime.lastError) return;
        if (seq !== requestSeq) return;
        if (!response?.ok) {
          // an unpreviewable target (File:, Help:, a redlink) still lands
          // somewhere useful instead of a dead click
          if (fallbackHref) window.open(fallbackHref, "_blank", "noopener");
          return;
        }
        if (fromArticle) historyStack.push({ article: fromArticle, left, top });
        renderPopup(response.data, { left, top });
      }
    );
  }

  // Pops the history stack and re-renders that article at its stored
  // position — no network request, since we already have the article data.
  function goBack() {
    if (!historyStack.length) return;
    const { article, left, top } = historyStack.pop();
    renderPopup(article, { left, top });
  }

  // The popup's current position in PAGE coordinates, regardless of whether
  // the host is currently absolute (page-anchored) or fixed (pinned to the
  // viewport). History entries and in-place navigation always store page
  // coordinates; renderPopup converts back when the popup is pinned.
  function currentPopupPagePosition() {
    const r = popupHost.getBoundingClientRect();
    return { left: r.left + window.scrollX, top: r.top + window.scrollY };
  }

  // A pinned popup stays put on screen while the page scrolls underneath:
  // switch the host between absolute (page coordinates) and fixed (viewport
  // coordinates), converting so it doesn't visually jump on toggle.
  function applyPinMode() {
    if (!popupHost) return;
    const r = popupHost.getBoundingClientRect();
    if (pinned) {
      popupHost.style.position = "fixed";
      popupHost.style.left = `${r.left}px`;
      popupHost.style.top = `${r.top}px`;
    } else {
      popupHost.style.position = "absolute";
      popupHost.style.left = `${r.left + window.scrollX}px`;
      popupHost.style.top = `${r.top + window.scrollY}px`;
    }
  }

  // Starts a popup drag from the grip button. Runs entirely against
  // popupHost's absolute-positioned left/top (already in page coordinates,
  // scroll offset included — see positionPopup), so the math stays in
  // viewport space until the very last step.
  function startDrag(e, gripBtn) {
    if (!popupHost) return;
    const hostRect = popupHost.getBoundingClientRect();
    const offsetX = e.clientX - hostRect.left;
    const offsetY = e.clientY - hostRect.top;
    gripBtn.classList.add("dragging");

    const onMove = (ev) => {
      if (!popupHost) return;
      // a pinned host is position:fixed and lives in viewport coordinates;
      // an unpinned one is absolute and needs the scroll offset added
      const fixed = popupHost.style.position === "fixed";
      popupHost.style.left =
        `${ev.clientX - offsetX + (fixed ? 0 : window.scrollX)}px`;
      popupHost.style.top =
        `${ev.clientY - offsetY + (fixed ? 0 : window.scrollY)}px`;
    };
    const onUp = () => {
      gripBtn.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Copies a plain-text citation to the clipboard, falling back to a
  // temporary textarea + execCommand inside the shadow root when the async
  // Clipboard API is unavailable or rejects (e.g. insecure context, denied
  // permission). Briefly swaps the button glyph to a checkmark on success.
  function copyCitation(article, button) {
    const text = `${article.title} - ${article.pageUrl}`;

    const flashSuccess = () => {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "✓";
      setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 1200);
    };

    const fallbackCopy = () => {
      const root = button.getRootNode();
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      root.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        if (document.execCommand("copy")) flashSuccess();
      } catch {
        // best-effort only — nothing more we can do here
      } finally {
        textarea.remove();
      }
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(flashSuccess, fallbackCopy);
    } else {
      fallbackCopy();
    }
  }

  // Builds the small inline speaker button shown after the title when the
  // article has a pronunciation audio clip.
  function buildAudioButton(audioUrl) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "audio-btn";
    btn.textContent = "🔊";
    btn.title = "Play pronunciation";
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      const audio = new Audio(audioUrl);
      const disablePermanently = () => {
        btn.disabled = true;
        btn.title = "Audio unavailable";
      };
      audio.addEventListener("error", disablePermanently);
      audio.addEventListener("ended", () => {
        btn.disabled = false;
      });
      btn.disabled = true;
      audio.play().then(() => {}, disablePermanently);
    });
    return btn;
  }

  function positionPopup(card, rect, cardWidth) {
    const margin = 8;

    // horizontal: centered on the selection, clamped to the viewport
    let left = rect.left + rect.width / 2 - cardWidth / 2;
    left = Math.max(
      margin,
      Math.min(left, window.innerWidth - cardWidth - margin)
    );

    // vertical: below the selection, or above if there is no room
    let top = rect.bottom + margin;
    const cardHeight = card.getBoundingClientRect().height || 220;
    if (top + cardHeight > window.innerHeight && rect.top - cardHeight - margin > 0) {
      top = rect.top - cardHeight - margin;
    }

    popupHost.style.left = `${left + window.scrollX}px`;
    popupHost.style.top = `${top + window.scrollY}px`;
  }

  function removePopup(animate = true) {
    if (!popupHost) return;
    const host = popupHost;
    const card = popupCard;
    popupHost = null;
    popupCard = null;
    currentArticle = null;
    darkReaderObserver?.disconnect();
    darkReaderObserver = null;
    if (animate && card && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      card.classList.add("out");
      setTimeout(() => host.remove(), 190);
    } else {
      host.remove();
    }
  }
})();
