"use strict";

const askToSave = document.getElementById("ask-to-save");
const suggest = document.getElementById("suggest-passwords");
const exceptions = document.getElementById("exceptions");
const showExceptions = document.getElementById("show-exceptions");
const list = document.getElementById("exception-list");
const removeAll = document.getElementById("remove-all");
const loginPattern = document.getElementById("login-pattern");
const loginPatternError = document.getElementById("login-pattern-error");
const DEFAULT_PATTERN = "{url}/{username}";

async function load() {
  const settings = await browser.storage.local.get({
    askToSave: true,
    suggestPasswords: true,
    neverSave: [],
    loginPattern: "",
    loginDir: "",
    loginLayout: "",
  });
  askToSave.checked = settings.askToSave;
  if (document.activeElement != loginPattern) {
    // Earlier builds stored the folder and the name separately.
    loginPattern.value =
      settings.loginPattern ||
      [settings.loginDir, settings.loginLayout || (settings.loginDir ? DEFAULT_PATTERN : "")].filter(Boolean).join("/") ||
      DEFAULT_PATTERN;
  }
  suggest.checked = settings.suggestPasswords;
  renderExceptions(settings.neverSave);
}

function renderExceptions(hosts) {
  list.replaceChildren(
    ...[...hosts].sort().map(host => {
      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.title = `Ask to save passwords for ${host} again`;
      remove.addEventListener("click", async () => {
        const { neverSave = [] } = await browser.storage.local.get("neverSave");
        await browser.storage.local.set({ neverSave: neverSave.filter(h => h != host) });
      });
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = host;
      item.append(name, remove);
      return item;
    })
  );
  document.getElementById("no-exceptions").hidden = hosts.length > 0;
  removeAll.disabled = hosts.length == 0;
}

askToSave.addEventListener("change", () => browser.storage.local.set({ askToSave: askToSave.checked }));
suggest.addEventListener("change", () => browser.storage.local.set({ suggestPasswords: suggest.checked }));
showExceptions.addEventListener("click", () => {
  exceptions.hidden = !exceptions.hidden;
  showExceptions.setAttribute("aria-expanded", String(!exceptions.hidden));
});
removeAll.addEventListener("click", () => browser.storage.local.set({ neverSave: [] }));

// Stay in step with "Never save" choices made while this page is open.
browser.storage.onChanged.addListener((changes, area) => {
  if (area == "local") {
    load();
  }
});

load();

// Same rules as the native host: {url} (or {site}) once, {username} at most
// once, no other placeholders, and every part a plain name in the store.
function patternProblem(value) {
  const placeholders = value.match(/\{[^}]*\}/g) ?? [];
  const count = (...names) => placeholders.filter(p => names.includes(p)).length;
  if (count("{url}", "{site}") != 1) {
    return "Include {url} once.";
  }
  if (count("{username}") > 1 || placeholders.some(p => !["{url}", "{site}", "{username}"].includes(p))) {
    return "Only {url} and {username} can be used, each once.";
  }
  if (value.split("/").some(part => !part || part == "." || part == ".." || part.startsWith("-"))) {
    return "Use names inside your password store, like www/{url}/{username}.";
  }
  return null;
}

loginPattern.addEventListener("change", () => {
  const value = loginPattern.value.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_PATTERN;
  const problem = patternProblem(value);
  loginPatternError.hidden = !problem;
  loginPatternError.textContent = problem ?? "";
  if (!problem) {
    loginPattern.value = value;
    browser.storage.local.set({ loginPattern: value });
    browser.storage.local.remove?.(["loginDir", "loginLayout"]);
  }
});
