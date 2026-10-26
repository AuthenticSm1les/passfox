"use strict";

const NATIVE_HOST = "io.github.smiley.passfox";
const LIST_TTL_MS = 60_000;
const PENDING_TTL_MS = 60_000;
const EXTENSION_ORIGIN = browser.runtime.getURL("");

// Two-label public suffixes common enough to matter for base-domain matching.
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "co.jp", "ne.jp", "or.jp",
  "com.au", "net.au", "org.au", "co.nz", "com.br", "co.in", "co.za",
  "com.mx", "com.tr", "com.cn", "com.tw", "co.kr", "com.sg", "com.ar",
]);

let listCache = null;
let cssCache = null;

// Where logins are stored, from passfox's preferences: one pattern from the
// store root with {url} (or {site}) and {username}, e.g. www/{url}/{username}.
// Its plain folders before the first placeholder are the login folder: every
// native request carries it, and the host lists, reads and writes nothing
// outside it. The rest is how each login is named.
const DEFAULT_PATTERN = "{url}/{username}";
let loginDir = "";
let loginLayout = DEFAULT_PATTERN;

function applyPattern(pattern) {
  const parts = (pattern || DEFAULT_PATTERN).split("/");
  const first = parts.findIndex(part => part.includes("{"));
  loginDir = parts.slice(0, first).join("/");
  loginLayout = parts.slice(first).join("/");
  listCache = null;
}

// Earlier builds stored the folder and the name separately.
function patternFrom({ loginPattern, loginDir: dir, loginLayout: layout }) {
  if (loginPattern) {
    return loginPattern;
  }
  return dir || layout ? [dir, layout || DEFAULT_PATTERN].filter(Boolean).join("/") : DEFAULT_PATTERN;
}

const settingsReady = browser.storage.local
  .get(["loginPattern", "loginDir", "loginLayout"])
  .then(settings => applyPattern(patternFrom(settings)));
browser.storage.onChanged.addListener((changes, area) => {
  if (area == "local" && changes.loginPattern) {
    applyPattern(changes.loginPattern.newValue);
  }
});

function inLoginDir(path) {
  return loginDir ? `${loginDir}/${path}` : path;
}

async function native(message) {
  const response = await browser.runtime.sendNativeMessage(NATIVE_HOST, {
    dir: loginDir,
    layout: loginLayout,
    ...message,
  });
  if (response?.error) {
    throw new Error(response.error);
  }
  return response;
}

async function allEntries({ force = false } = {}) {
  if (force || !listCache || Date.now() - listCache.at > LIST_TTL_MS) {
    const { entries } = await native({ action: "list" });
    listCache = { at: Date.now(), entries };
  }
  return listCache.entries;
}

function stripPort(host) {
  return host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

function baseDomain(host) {
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) {
    return host;
  }
  const labels = host.split(".");
  const take = MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** What Firefox stores as a login's site: scheme://host[:port]. */
function originOf(url) {
  return new URL(url).origin;
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.hostname : null;
  } catch {
    return null;
  }
}

/** Entries for a page, exact-host matches first, like Firefox's login list. */
async function loginsForUrl(url) {
  const host = hostOf(url);
  if (!host) {
    return [];
  }
  const base = baseDomain(host);
  const matches = [];
  for (const entry of await allEntries()) {
    if (!entry.domain) {
      continue;
    }
    const domain = stripPort(entry.domain);
    const exact = domain === host || domain === `www.${host}` || `www.${domain}` === host;
    if (exact || baseDomain(domain) === base) {
      matches.push({ ...entry, exact });
    }
  }
  return matches.sort(
    (a, b) => b.exact - a.exact || a.username.localeCompare(b.username)
  );
}

async function requireMatch(url, path) {
  const entry = (await loginsForUrl(url)).find(e => e.path === path);
  if (!entry) {
    throw new Error("Entry does not belong to this site");
  }
  return entry;
}

function isExtensionPage(sender) {
  return sender.id === browser.runtime.id && sender.url?.startsWith(EXTENSION_ORIGIN);
}


/* ::::: Firefox's own password manager ::::: */

// passfox takes over saving passwords, so switch off Firefox's own "Ask to
// save passwords"; otherwise Firefox prompts too, on every website and on
// the passwords page. Firefox restores the setting if passfox is removed or
// disabled, and its saved logins are left alone.
async function takeOverPasswordSaving() {
  const setting = browser.privacy.services.passwordSavingEnabled;
  const { value, levelOfControl } = await setting.get({});
  if (value && ["controllable_by_this_extension", "controlled_by_this_extension"].includes(levelOfControl)) {
    await setting.set({ value: false });
  }
}

browser.runtime.onInstalled.addListener(() => takeOverPasswordSaving().catch(() => {}));
browser.runtime.onStartup.addListener(() => takeOverPasswordSaving().catch(() => {}));

/* ::::: save / update doorhanger state ::::: */

function pendingKey(tabId) {
  return `pending-${tabId}`;
}

async function getPending(tabId) {
  const key = pendingKey(tabId);
  const { [key]: pending } = await browser.storage.session.get(key);
  if (pending && Date.now() - pending.at < PENDING_TTL_MS) {
    return pending;
  }
  return null;
}

function clearPending(tabId) {
  return browser.storage.session.remove(pendingKey(tabId));
}

browser.tabs.onRemoved.addListener(clearPending);

const GENERATED_PREFIX = "passfox-generated-";

// Where generated passwords wait when the name pattern has no {username}.
const GENERATED_FOLDER = "passfox-generated";

function isGeneratedPath(path) {
  const parts = path?.split("/") ?? [];
  return !!parts.at(-1)?.startsWith(GENERATED_PREFIX) || parts.slice(0, -1).includes(GENERATED_FOLDER);
}

/** The entry for a login, named by the pattern from passfox's preferences. */
function savePathFor(host, username) {
  const name = (username || "login").replace(/[/\\]/g, "_").replace(/^[.-]+/, "_");
  return inLoginDir(loginLayout.replace(/\{(url|site)\}/, host).replace("{username}", name));
}

function generatedPathFor(host) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return loginLayout.includes("{username}")
    ? savePathFor(host, GENERATED_PREFIX + stamp)
    : inLoginDir(`${GENERATED_FOLDER}/${host}/${stamp}`);
}

async function neverSaveHosts() {
  const { neverSave = [] } = await browser.storage.local.get("neverSave");
  return neverSave;
}

async function onSubmitted(sender, { username, password, possibleUsernames = [], filledPath, filledPassword }) {
  const host = hostOf(sender.url);
  if (!host || !password || !sender.tab) {
    return;
  }
  // Settings: "Ask to save passwords" and its exceptions.
  const { askToSave = true } = await browser.storage.local.get("askToSave");
  if (!askToSave || (await neverSaveHosts()).includes(host)) {
    return;
  }
  const logins = await loginsForUrl(sender.url);
  if (filledPath && password === filledPassword) {
    // A generated password saved without a username: offer to add the one
    // the form was submitted with, like Firefox's "Add username to saved
    // password?" (or fold it into that login if it already exists).
    if (isGeneratedPath(filledPath) && username) {
      const existing =
        logins.find(e => e.username === username && !isGeneratedPath(e.path)) ??
        logins.find(e => e.path == savePathFor(host, username) && !isGeneratedPath(e.path));
      await presentPending(sender.tab, {
        mode: existing ? "update" : "add-username",
        from: filledPath,
        path: existing?.path ?? savePathFor(host, username),
        username,
        host,
        url: originOf(sender.url),
        password,
        usernameSuggestions: [],
        at: Date.now(),
      });
    }
    return;
  }

  // With a pattern like {site}, the username isn't in the name: the entry
  // the pattern points at is the existing login.
  const target = savePathFor(host, username);
  const sameUser = logins.find(e => e.exact && e.username === (username || ""))
    ?? logins.find(e => e.username === (username || "") && username)
    ?? logins.find(e => e.path == target && !isGeneratedPath(e.path));
  let pending;
  if (sameUser) {
    const current = await native({ action: "get", path: sameUser.path });
    if (current.password === password) {
      return;
    }
    pending = { mode: "update", path: sameUser.path, username: username || "" };
  } else {
    pending = { mode: "save", path: null, username: username || "" };
  }
  // Same order as LoginManagerPrompter._getUsernameSuggestions: usernames
  // seen in the form first, then saved ones for the base domain.
  const usernameSuggestions = [
    ...new Set([...possibleUsernames, ...logins.map(e => e.username)].filter(Boolean)),
  ];
  Object.assign(pending, { host, url: originOf(sender.url), password, usernameSuggestions, at: Date.now() });
  await presentPending(sender.tab, pending);
}

/**
 * Show the doorhanger as a real Firefox panel hanging from the toolbar
 * button (the popup renders it while a save is pending). Opening a popup
 * without a click is allowed by default (extensions.openPopupWithoutUserGesture
 * .enabled) but needs the window focused; otherwise fall back to the page.
 */
async function presentPending(tab, pending) {
  const key = pendingKey(tab.id);
  await browser.storage.session.set({ [key]: pending });
  try {
    await browser.action.openPopup({ windowId: tab.windowId });
  } catch (error) {
    console.info("passfox: toolbar panel unavailable, showing in page:", error.message);
    pending.inPage = true;
    await browser.storage.session.set({ [key]: pending });
    browser.tabs.sendMessage(tab.id, { type: "show-save", pending }, { frameId: 0 }).catch(() => {});
  }
}

async function onPendingDone(sender, { action, username, password, tabId: pageTabId }) {
  const tabId = isExtensionPage(sender) ? pageTabId : sender.tab.id;
  const pending = await getPending(tabId);
  await clearPending(tabId);
  if (!pending) {
    return { ok: false };
  }
  if (action == "never") {
    const hosts = await neverSaveHosts();
    await browser.storage.local.set({ neverSave: [...new Set([...hosts, pending.host])] });
  } else if (pending.from && (action == "update" || action == "add-username" || action == "save")) {
    const path = username === pending.username ? pending.path : savePathFor(pending.host, username);
    await native({ action: "adopt", from: pending.from, to: path, username, url: pending.url });
    listCache = null;
  } else if (action == "save" || action == "update") {
    const path =
      action == "update" && pending.path ? pending.path : savePathFor(pending.host, username);
    await native({ action: "insert", path, username, password, url: pending.url });
    listCache = null;
  }
  return { ok: true };
}

/* ::::: messaging ::::: */

async function loadCss() {
  if (!cssCache) {
    const files = [
      "vendor/firefox/tokens-shared.css",
      "vendor/firefox/tokens-platform.css",
      "shared/firefox.css",
    ];
    const texts = await Promise.all(
      files.map(f => fetch(browser.runtime.getURL(f)).then(r => r.text()))
    );
    cssCache = texts.join("\n");
  }
  return cssCache;
}

async function tabUrl(tabId) {
  return (await browser.tabs.get(tabId)).url;
}

const handlers = {
  css: () => loadCss(),

  // Content scripts get the logins for their own frame; the toolbar panel
  // passes its tab.
  async logins(msg, sender) {
    if (!isExtensionPage(sender)) {
      return loginsForUrl(sender.url);
    }
    return loginsForUrl(await tabUrl(msg.tabId));
  },

  async fill(msg, sender) {
    const url = isExtensionPage(sender) ? await tabUrl(msg.tabId) : sender.url;
    await requireMatch(url, msg.path);
    const { username, password } = await native({ action: "get", path: msg.path });
    const login = { path: msg.path, username: username ?? "", password };
    if (isExtensionPage(sender)) {
      await browser.tabs.sendMessage(msg.tabId, { type: "fill", login }, { frameId: 0 });
      return { ok: true };
    }
    return login;
  },

  async copy(msg, sender) {
    if (!isExtensionPage(sender)) {
      throw new Error("Not allowed");
    }
    if (msg.field == "username") {
      const entry = await native({ action: "get", path: msg.path });
      await navigator.clipboard.writeText(entry.username ?? "");
    } else {
      // pass copies it and restores the clipboard after its clip time.
      await native({ action: "clip", path: msg.path });
    }
    return { ok: true };
  },

  submitted: (msg, sender) => onSubmitted(sender, msg),

  // "Use a Securely Generated Password": pass generates and stores it.
  async generate(msg, sender) {
    const host = hostOf(sender.url);
    if (!host) {
      throw new Error("Not a website");
    }
    const result = await native({
      action: "generate",
      path: generatedPathFor(host),
      url: originOf(sender.url),
    });
    listCache = null;
    return { path: result.entry.path, username: "", password: result.password };
  },

  // Content scripts ask for their own tab, the toolbar popup for the active one.
  async pending(msg, sender) {
    const fromPopup = isExtensionPage(sender);
    const tabId = fromPopup ? msg.tabId : sender.tab?.id;
    const pending = tabId != null && (await getPending(tabId));
    const host = hostOf(fromPopup ? await tabUrl(tabId) : sender.url);
    if (pending && host && baseDomain(host) === baseDomain(pending.host)) {
      return pending;
    }
    return null;
  },

  pendingDone: (msg, sender) => onPendingDone(sender, msg),

  // Firefox's about:logins, rebuilt in logins/: open it (or switch to it)
  // with a login or the current site selected, like Firefox does from the
  // autocomplete footer and the edit pencil.
  async openManager(msg, sender) {
    const select = msg.select ?? (sender.tab && hostOf(sender.url)) ?? null;
    const page = browser.runtime.getURL("logins/logins.html");
    const { managerTab } = await browser.storage.session.get("managerTab");
    const tab = managerTab != null && (await browser.tabs.get(managerTab).catch(() => null));
    if (tab?.url?.startsWith(page)) {
      await browser.tabs.update(tab.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
      browser.runtime.sendMessage({ type: "select-login", select }).catch(() => {});
      return;
    }
    // Handed over through session storage rather than the URL.
    await browser.storage.session.set({ managerSelect: select });
    const created = await browser.tabs.create({ url: page });
    await browser.storage.session.set({ managerTab: created.id });
  },

  /* ::::: the passwords page (extension page only) ::::: */

  async "manager-list"(msg, sender) {
    requireExtensionPage(sender);
    return allEntries({ force: true });
  },

  async "manager-get"(msg, sender) {
    requireExtensionPage(sender);
    return native({ action: "get", path: msg.path });
  },

  async "manager-create"(msg, sender) {
    requireExtensionPage(sender);
    const { host, url } = siteOf(msg.origin);
    const path = savePathFor(host, msg.username);
    await rejectDuplicate(path, msg.username, url);
    await native({ action: "insert", path, username: msg.username, password: msg.password, url });
    listCache = null;
    return { path, domain: host, username: msg.username, modified: Date.now() };
  },

  async "manager-update"(msg, sender) {
    requireExtensionPage(sender);
    const old = (await allEntries({ force: true })).find(e => e.path == msg.path);
    if (!old) {
      throw new Error("That login no longer exists in pass");
    }
    const { host, url } = siteOf(msg.origin);
    // Compare with the entry's real username (its login: line, if any), so
    // an edit only renames when the site or username really changed.
    const current = await native({ action: "get", path: msg.path });
    const changed = host != old.domain || (msg.username ?? "") != (current.username ?? old.username ?? "");
    const target = savePathFor(host, msg.username);
    const renamed = changed && target != msg.path;
    const path = renamed ? target : msg.path;
    if (renamed) {
      await rejectDuplicate(path, msg.username, url);
    }
    await native({ action: "edit", path: msg.path, to: path, username: msg.username, password: msg.password, url });
    listCache = null;
    return { path, domain: host, username: msg.username, modified: Date.now() };
  },

  async "manager-remove"(msg, sender) {
    requireExtensionPage(sender);
    await native({ action: "remove", path: msg.path });
    listCache = null;
    return { ok: true };
  },
};

function requireExtensionPage(sender) {
  if (!isExtensionPage(sender)) {
    throw new Error("Not allowed");
  }
}

function siteOf(origin) {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("The website address must start with http:// or https://");
  }
  return { host: url.hostname, url: url.origin };
}

// Firefox's "This login already exists" error, which the page turns into
// "An entry for … already exists. Go to existing entry?"
async function rejectDuplicate(path, username, url) {
  const host = new URL(url).hostname;
  const existing = (await allEntries({ force: true })).find(
    e => e.path == path || (e.domain == host && e.username == (username ?? ""))
  );
  if (existing) {
    const error = new Error("This login already exists.");
    error.existingLoginGuid = existing.path;
    throw error;
  }
}

browser.runtime.onMessage.addListener((msg, sender) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    return undefined;
  }
  return settingsReady.then(() => handler(msg, sender)).then(
    result => ({ result }),
    error => ({ error: String(error?.message ?? error), existingLoginGuid: error?.existingLoginGuid })
  );
});
