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
};

const languageSelect = document.getElementById("language");
const exactMatchInput = document.getElementById("exactMatch");
const statusEl = document.getElementById("status");
let statusTimer = null;

for (const [code, label] of LANGUAGES) {
  const option = document.createElement("option");
  option.value = code;
  option.textContent = label;
  languageSelect.appendChild(option);
}

chrome.storage.sync.get(DEFAULTS, (settings) => {
  languageSelect.value = settings.language;
  exactMatchInput.checked = settings.exactMatch;
  checkRadio("size", settings.size);
  checkRadio("theme", settings.theme);
});

languageSelect.addEventListener("change", () =>
  save({ language: languageSelect.value })
);

exactMatchInput.addEventListener("change", () =>
  save({ exactMatch: exactMatchInput.checked })
);

for (const name of ["size", "theme"]) {
  document.getElementById(name).addEventListener("change", (e) => {
    if (e.target.name === name) save({ [name]: e.target.value });
  });
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
