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

  let settings = { size: "medium", theme: "dark" };
  chrome.storage.sync.get(settings, (stored) => {
    settings = { size: stored.size, theme: stored.theme };
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.size) settings.size = changes.size.newValue;
    if (changes.theme) settings.theme = changes.theme.newValue;
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
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runLookup, DEBOUNCE_MS);
  }

  function runLookup() {
    if (isEditableContext()) return;
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
    removePopup(false); // replace instantly, no exit animation overlap
    const rect = selectionRect();
    if (!rect) return;

    popupHost = document.createElement("div");
    popupHost.style.cssText =
      "position:absolute;z-index:2147483647;width:0;height:0;";
    const shadow = popupHost.attachShadow({ mode: "closed" });

    const size = SIZES[settings.size] ?? SIZES.medium;
    const theme = THEMES[settings.theme] ?? THEMES.dark;

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
      .thumb {
        display: block;
        width: 100%;
        aspect-ratio: 1 / 1;
        object-fit: cover;
        /* favor the upper part of the image so portrait faces stay in frame */
        object-position: 50% 20%;
        background: ${theme.thumbBg};
        animation: wl-settle 0.9s cubic-bezier(0.22, 1, 0.36, 1) backwards;
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
    `;
    shadow.appendChild(style);

    const card = document.createElement("div");
    card.className = "card";

    if (article.thumbnail) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = article.thumbnail;
      img.alt = article.title;
      card.appendChild(img);
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

    const footer = document.createElement("div");
    footer.className = "footer";
    const link = document.createElement("a");
    link.className = "link";
    link.href = article.pageUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Read in Wikipedia ";
    const arr = document.createElement("span");
    arr.className = "arr";
    arr.textContent = "→";
    link.appendChild(arr);
    footer.appendChild(link);
    card.appendChild(footer);

    shadow.appendChild(card);
    popupCard = card;
    document.documentElement.appendChild(popupHost);

    // scale the whole card down proportionally when the viewport is
    // narrower than the card (zoom scales layout without touching the
    // entrance animation's transform)
    const baseWidth = (SIZES[settings.size] ?? SIZES.medium).width;
    const scale = Math.min(1, (window.innerWidth - 24) / baseWidth);
    if (scale < 1) card.style.zoom = scale;

    positionPopup(card, rect, baseWidth * scale);
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
