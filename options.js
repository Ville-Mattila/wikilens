const LANGUAGES = [
  ["ar", "العربية — Arabic"],
  ["cs", "Čeština — Czech"],
  ["da", "Dansk — Danish"],
  ["de", "Deutsch — German"],
  ["en", "English"],
  ["es", "Español — Spanish"],
  ["et", "Eesti — Estonian"],
  ["fi", "Suomi — Finnish"],
  ["fr", "Français — French"],
  ["he", "עברית — Hebrew"],
  ["hu", "Magyar — Hungarian"],
  ["it", "Italiano — Italian"],
  ["ja", "日本語 — Japanese"],
  ["ko", "한국어 — Korean"],
  ["nl", "Nederlands — Dutch"],
  ["no", "Norsk — Norwegian"],
  ["pl", "Polski — Polish"],
  ["pt", "Português — Portuguese"],
  ["ru", "Русский — Russian"],
  ["sv", "Svenska — Swedish"],
  ["tr", "Türkçe — Turkish"],
  ["uk", "Українська — Ukrainian"],
  ["zh", "中文 — Chinese"],
];

const DEFAULTS = {
  language: "en",
  size: "medium",
  theme: "dark",
  exactMatch: true,
  trigger: "select",
  disabledSites: [],
};

const languageSelect = document.getElementById("language");
const exactMatchInput = document.getElementById("exactMatch");
const disabledSitesInput = document.getElementById("disabledSites");
const statusEl = document.getElementById("status");
let statusTimer = null;
let disabledSitesTimer = null;

for (const [code, label] of LANGUAGES) {
  const option = document.createElement("option");
  option.value = code;
  option.textContent = label;
  languageSelect.appendChild(option);
}

chrome.storage.sync.get(DEFAULTS, (settings) => {
  languageSelect.value = settings.language;
  exactMatchInput.checked = settings.exactMatch;
  disabledSitesInput.value = settings.disabledSites.join("\n");
  checkRadio("size", settings.size);
  checkRadio("theme", settings.theme);
  checkRadio("trigger", settings.trigger);
});

languageSelect.addEventListener("change", () =>
  save({ language: languageSelect.value })
);

exactMatchInput.addEventListener("change", () =>
  save({ exactMatch: exactMatchInput.checked })
);

disabledSitesInput.addEventListener("input", () => {
  clearTimeout(disabledSitesTimer);
  disabledSitesTimer = setTimeout(() => {
    save({ disabledSites: parseDisabledSites(disabledSitesInput.value) });
  }, 500);
});

for (const name of ["size", "theme", "trigger"]) {
  document.getElementById(name).addEventListener("change", (e) => {
    if (e.target.name === name) save({ [name]: e.target.value });
  });
}

function parseDisabledSites(raw) {
  const hosts = [];
  for (const line of raw.split("\n")) {
    let host = line.trim();
    if (!host) continue;
    host = host.toLowerCase();
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip protocol, e.g. https://
    host = host.split(/[/?#]/)[0]; // strip path/query/hash if a full URL was pasted
    if (host) hosts.push(host);
  }
  return hosts;
}

function checkRadio(name, value) {
  const input = document.querySelector(
    `input[name="${name}"][value="${value}"]`
  );
  if (input) input.checked = true;
}

function save(patch) {
  chrome.storage.sync.set(patch, () => {
    statusEl.classList.add("visible");
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => statusEl.classList.remove("visible"), 1500);
  });
}
