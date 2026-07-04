// WikiLens content script: watches text selection, asks the background
// worker whether it matches an exact Wikipedia article, and shows a
// small preview popup near the selection.

(() => {
  const MAX_TITLE_LENGTH = 80;
  const DEBOUNCE_MS = 250;

  // textMax: the snippet area scrolls once the paragraph exceeds this height
  const SIZES = {
    small: { width: 260, textMax: 110, imgHeight: 120, title: 14, text: 12 },
    medium: { width: 320, textMax: 195, imgHeight: 160, title: 16, text: 13 },
    large: { width: 400, textMax: 290, imgHeight: 210, title: 18, text: 14 },
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

  function scheduleLookup(event) {
    if (popupHost && event.composedPath?.().includes(popupHost)) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runLookup, DEBOUNCE_MS);
  }

  function runLookup() {
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
    removePopup();
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
        animation: wikilens-in 0.15s ease-out;
      }
      @keyframes wikilens-in {
        from { opacity: 0; transform: translateY(4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .thumb {
        display: block;
        width: 100%;
        max-height: ${size.imgHeight}px;
        object-fit: cover;
        background: ${theme.thumbBg};
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

    const footer = document.createElement("div");
    footer.className = "footer";
    const link = document.createElement("a");
    link.className = "link";
    link.href = article.pageUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Read in Wikipedia →";
    footer.appendChild(link);
    card.appendChild(footer);

    shadow.appendChild(card);
    document.documentElement.appendChild(popupHost);

    positionPopup(card, rect);
  }

  function positionPopup(card, rect) {
    const cardWidth = (SIZES[settings.size] ?? SIZES.medium).width;
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

  function removePopup() {
    if (popupHost) {
      popupHost.remove();
      popupHost = null;
    }
  }
})();
