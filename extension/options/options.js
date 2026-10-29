"use strict";

const askToSave = document.getElementById("ask-to-save");
const suggest = document.getElementById("suggest-passwords");
const ignoreTld = document.getElementById("ignore-tld");
const exceptions = document.getElementById("exceptions");
const showExceptions = document.getElementById("show-exceptions");
const list = document.getElementById("exception-list");
const removeAll = document.getElementById("remove-all");
const loginPattern = document.getElementById("login-pattern");
const loginPatternError = document.getElementById("login-pattern-error");
const otpSeparate = document.getElementById("otp-separate");
const otpPattern = document.getElementById("otp-pattern");
const otpPatternError = document.getElementById("otp-pattern-error");
const DEFAULT_PATTERN = "{url}/{username}";
const DEFAULT_OTP_PATTERN = "otp/{url}";

async function load() {
  const settings = await browser.storage.local.get({
    askToSave: true,
    suggestPasswords: true,
    ignoreTld: false,
    neverSave: [],
    loginPattern: "",
    loginDir: "",
    loginLayout: "",
    otpPattern: "",
    otpSeparate: null,
  });
  askToSave.checked = settings.askToSave;
  if (document.activeElement != loginPattern) {
    // Earlier builds stored the folder and the name separately.
    loginPattern.value =
      settings.loginPattern ||
      [settings.loginDir, settings.loginLayout || (settings.loginDir ? DEFAULT_PATTERN : "")].filter(Boolean).join("/") ||
      DEFAULT_PATTERN;
  }
  // Earlier builds had no switch: a saved pattern meant a different place.
  otpSeparate.checked = settings.otpSeparate ?? !!settings.otpPattern;
  otpPattern.disabled = !otpSeparate.checked;
  if (document.activeElement != otpPattern) {
    // Switched off, the field shows where codes are read from: the logins.
    otpPattern.value = otpSeparate.checked ? settings.otpPattern || DEFAULT_OTP_PATTERN : loginPattern.value;
  }
  if (!otpSeparate.checked) {
    otpPatternError.hidden = true;
  }
  suggest.checked = settings.suggestPasswords;
  ignoreTld.checked = settings.ignoreTld;
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
ignoreTld.addEventListener("change", () => browser.storage.local.set({ ignoreTld: ignoreTld.checked }));
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

// Same rules as the native host: {url} (or {site}) or {domain} once,
// {username} at most once, no other placeholders, and every part a plain
// name in the store.
// A plain folder (no placeholders) is fine too: any layout inside it.
function patternProblem(value) {
  const placeholders = value.match(/\{[^}]*\}/g) ?? [];
  const count = (...names) => placeholders.filter(p => names.includes(p)).length;
  if (placeholders.length && count("{url}", "{site}", "{domain}") != 1) {
    return "Include {url} or {domain} once.";
  }
  if (count("{username}") > 1 || placeholders.some(p => !["{url}", "{site}", "{domain}", "{username}"].includes(p))) {
    return "Only {url} or {domain}, and {username}, can be used, each once.";
  }
  if (value.split("/").some(part => !part || part == "." || part == ".." || part.startsWith("-"))) {
    return "Use a folder inside your password store, like www, or a pattern like www/{url}/{username}.";
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

// Switched off, codes are read from each login's own entry; the pattern is
// kept for when it's switched on again.
otpSeparate.addEventListener("change", async () => {
  const { otpPattern: saved = "" } = await browser.storage.local.get("otpPattern");
  await browser.storage.local.set({
    otpSeparate: otpSeparate.checked,
    otpPattern: otpSeparate.checked ? saved || DEFAULT_OTP_PATTERN : saved,
  });
  if (otpSeparate.checked) {
    otpPattern.focus();
  }
});

otpPattern.addEventListener("change", () => {
  const value = otpPattern.value.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_OTP_PATTERN;
  const problem = patternProblem(value);
  otpPatternError.hidden = !problem;
  otpPatternError.textContent = problem ?? "";
  if (!problem) {
    otpPattern.value = value;
    browser.storage.local.set({ otpPattern: value });
  }
});
