// WikiLens content script: watches text selection, asks the background
// worker whether it matches an exact Wikipedia article, and shows a
// small preview popup near the selection.

(() => {
  const MAX_TITLE_LENGTH = 80;
  const DEBOUNCE_MS = 250;

  // textMax: the snippet area scrolls once the paragraph exceeds this height.
  // Medium and Large share dimensions; Large additionally shows quick facts.
  const SIZES = {
    small: { width: 260, textMax: 110, title: 14, text: 12 },
    medium: { width: 400, textMax: 290, title: 18, text: 14 },
    large: { width: 400, textMax: 290, title: 18, text: 14 },
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
    disabledSites: [],
  };
  chrome.storage.sync.get(settings, (stored) => {
    settings = {
      size: stored.size,
      theme: stored.theme,
      trigger: stored.trigger,
      disabledSites: stored.disabledSites,
    };
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.size) settings.size = changes.size.newValue;
    if (changes.theme) settings.theme = changes.theme.newValue;
    if (changes.trigger) settings.trigger = changes.trigger.newValue;
    if (changes.disabledSites) settings.disabledSites = changes.disabledSites.newValue;
  });

  let popupHost = null;
  let popupCard = null; // direct reference; the shadow root is closed
  let debounceTimer = null;
  let requestSeq = 0; // guards against out-of-order async responses

  document.addEventListener("mouseup", scheduleLookup);
  document.addEventListener("keyup", (e) => {
    // catch keyboard selections (shift+arrows, ctrl+a on a paragraph, etc.)
    if (e.shiftKey || e.key === "Shift") scheduleLookup(e);
  });
  document.addEventListener("mousedown", (e) => {
    if (popupHost && !e.composedPath().includes(popupHost)) removePopup();
  });
  document.addEventListener("selectionchange", () => {
    const sel = document.getSelection();
    if (popupHost && (!sel || sel.isCollapsed)) removePopup();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && popupHost) removePopup();
  });

  function scheduleLookup(event) {
    if (popupHost && event.composedPath?.().includes(popupHost)) return;
    if (settings.trigger === "alt" && !event.altKey) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runLookup, DEBOUNCE_MS);
  }

  function runLookup() {
    if (isEditableContext()) return;
    if (isDisabledSite()) return;
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
    renderPopup(article, { rect });
  }

  // Renders a popup either anchored to the current selection rect, or at a
  // fixed page position (left/top, already including scroll offset) — used
  // when replacing a disambiguation card with an article card after an
  // option click, at which point the original selection may be gone.
  function renderPopup(article, position) {
    removePopup(false); // replace instantly, no exit animation overlap

    popupHost = document.createElement("div");
    popupHost.style.cssText =
      "position:absolute;z-index:2147483647;width:0;height:0;";
    const shadow = popupHost.attachShadow({ mode: "closed" });

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
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
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
        aspect-ratio: 1 / 1;
        object-fit: cover;
        /* favor the upper part of the image so portrait faces stay in frame */
        object-position: 50% 20%;
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
        .card, .card.out, .thumb, .title, .extract, .facts, .footer { animation: none; }
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
      .footer {
        border-top: 1px solid ${theme.divider};
        padding: 8px 14px;
        text-align: right;
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
    document.documentElement.appendChild(popupHost);

    // scale the whole card down proportionally when the viewport is
    // narrower than the card (zoom scales layout without touching the
    // entrance animation's transform)
    const baseWidth = (SIZES[settings.size] ?? SIZES.medium).width;
    const scale = Math.min(1, (window.innerWidth - 24) / baseWidth);
    if (scale < 1) card.style.zoom = scale;

    if (position.rect) {
      positionPopup(card, position.rect, baseWidth * scale);
    } else {
      popupHost.style.left = `${position.left}px`;
      popupHost.style.top = `${position.top}px`;
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
      const wrap = document.createElement("div");
      wrap.className = "thumbwrap";
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = images[0];
      img.alt = article.title;
      wrap.appendChild(img);

      if (images.length > 1) {
        let index = 0;
        const counter = document.createElement("span");
        counter.className = "imgcount";
        counter.textContent = `1 / ${images.length}`;

        const next = document.createElement("button");
        next.type = "button";
        next.className = "imgnav";
        next.textContent = "›";
        next.title = "Next image";
        // preserve the text selection, same as the disambiguation options —
        // otherwise the selectionchange handler dismisses the popup
        next.addEventListener("mousedown", (e) => e.preventDefault());
        next.addEventListener("click", () => {
          index = (index + 1) % images.length;
          counter.textContent = `${index + 1} / ${images.length}`;
          img.classList.add("fade");
          setTimeout(() => {
            img.src = images[index];
            img.onload = () => img.classList.remove("fade");
          }, 160);
          // warm the cache for the frame after this one
          new Image().src = images[(index + 1) % images.length];
        });

        wrap.append(next, counter);
        new Image().src = images[1]; // first click should be instant
      }
      card.appendChild(wrap);
    }

    const body = document.createElement("div");
    body.className = "body";
    const title = document.createElement("p");
    title.className = "title";
    title.textContent = article.title;
    const extract = document.createElement("p");
    extract.className = "extract";
    extract.textContent = article.extract;
    body.append(title, extract);
    card.appendChild(body);

    if (article.facts?.length) {
      const facts = document.createElement("div");
      facts.className = "facts";
      for (const fact of article.facts) {
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
            value.appendChild(a);
          } else {
            value.appendChild(document.createTextNode(part.text));
          }
        });
        facts.append(label, value);
      }
      card.appendChild(facts);
    }

    card.appendChild(buildFooter(article.pageUrl));
    return card;
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
    subtitle.textContent = "may refer to:";
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

    card.appendChild(buildFooter(article.pageUrl));
    return card;
  }

  function buildFooter(pageUrl) {
    const footer = document.createElement("div");
    footer.className = "footer";
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

  // Clicking a disambiguation option looks up that title directly. The
  // current popup position (which may no longer correspond to any live
  // text selection) is captured first so the replacement article card can
  // be placed in the same spot. On failure the list is left as-is.
  function selectDisambiguationOption(optionTitle) {
    if (!popupHost) return;
    const left = parseFloat(popupHost.style.left) || 0;
    const top = parseFloat(popupHost.style.top) || 0;

    const seq = ++requestSeq;
    chrome.runtime.sendMessage(
      { type: "wikilens-lookup", title: optionTitle },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (seq !== requestSeq) return;
        if (!response?.ok) return;
        renderPopup(response.data, { left, top });
      }
    );
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
    if (animate && card && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      card.classList.add("out");
      setTimeout(() => host.remove(), 190);
    } else {
      host.remove();
    }
  }
})();
