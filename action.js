const searchInput = document.getElementById("searchInput");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const recentsEl = document.getElementById("recents");
const settingsBtn = document.getElementById("settingsBtn");

settingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const title = searchInput.value.trim();
  if (title) runLookup(title);
});

function runLookup(title) {
  resultsEl.replaceChildren();
  statusEl.textContent = "Searching…";

  chrome.runtime.sendMessage({ type: "wikilens-lookup", title }, (response) => {
    statusEl.textContent = "";

    if (!response?.ok) {
      statusEl.textContent = "No exact match.";
      return;
    }

    const data = response.data;
    if (data?.disambiguation) {
      renderDisambiguation(data);
    } else {
      renderResult(data);
    }
  });
}

function renderResult(data) {
  resultsEl.replaceChildren(makeRow(data.title, data.thumbnail, () => {
    chrome.tabs.create({ url: data.pageUrl });
  }));
}

function renderDisambiguation(data) {
  const rows = data.options.map((option) =>
    makeRow(option, null, () => {
      searchInput.value = option;
      runLookup(option);
    })
  );
  resultsEl.replaceChildren(...rows);
}

function makeRow(title, thumbnail, onClick) {
  const row = document.createElement("div");
  row.className = "row";
  row.addEventListener("click", onClick);

  if (thumbnail) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = thumbnail;
    img.alt = "";
    row.appendChild(img);
  }

  const titleEl = document.createElement("div");
  titleEl.className = "title";
  titleEl.textContent = title;
  row.appendChild(titleEl);

  return row;
}

function loadRecents() {
  chrome.storage.local.get({ recents: [] }, ({ recents }) => {
    recentsEl.replaceChildren();

    if (!recents.length) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Previews you open will appear here.";
      recentsEl.appendChild(hint);
      return;
    }

    for (const entry of recents) {
      recentsEl.appendChild(
        makeRow(entry.title, entry.thumbnail, () => {
          chrome.tabs.create({ url: entry.pageUrl });
        })
      );
    }
  });
}

loadRecents();
