"use strict";

/* Stands in for Firefox's AboutLogins actors on the passwords page: it
 * answers the page's AboutLogins* events from pass (through passfox's
 * background and native host) and sends AboutLoginsChromeToContent
 * messages back, so Firefox's own about:logins code runs unchanged.
 *
 * Passwords aren't sent to the page up front. Firefox asks for
 * authentication (promptForPrimaryPassword) before it reveals, copies or
 * edits a password; at that point this decrypts just that entry, so the
 * gpg-agent's pinentry plays the part of Firefox's OS authentication. */
(() => {
  // Firefox's CONCEALED_PASSWORD_TEXT: what a masked, not yet loaded
  // password holds.
  const CONCEALED = " ".repeat(8);
  const HELP_URL = "https://github.com/AuthenticSm1les/passfox#using-passfox";
  const SUBDOMAIN = /^www\d*\./;

  async function call(type, data = {}) {
    const reply = await browser.runtime.sendMessage({ type, ...data });
    if (reply?.error) {
      const error = new Error(reply.error);
      error.existingLoginGuid = reply.existingLoginGuid;
      throw error;
    }
    return reply?.result;
  }

  function send(messageType, value) {
    window.dispatchEvent(
      new CustomEvent("AboutLoginsChromeToContent", { detail: { messageType, value } })
    );
  }

  /** A pass entry as the vanilla login object about:logins works with. */
  function toLogin(entry, details = {}) {
    // A login whose folder isn't a website is titled after its folder.
    const parts = entry.path.split("/");
    const host = entry.domain ?? parts.at(-2) ?? parts[0];
    let origin = entry.domain ? `https://${entry.domain}` : "";
    if (details.url) {
      try {
        origin = new URL(details.url).origin;
      } catch {}
    }
    const time = entry.modified ?? Date.now();
    return {
      guid: entry.path,
      origin,
      formActionOrigin: origin,
      httpRealm: null,
      displayOrigin: host,
      title: host.replace(SUBDOMAIN, ""),
      username: details.username ?? entry.username ?? "",
      password: details.password ?? CONCEALED,
      timeCreated: time,
      timeLastUsed: time,
      timePasswordChanged: time,
      timesUsed: 1,
    };
  }

  const loginItem = () => document.querySelector("login-item");
  const loginList = () => document.querySelector("login-list");

  function showError(login, error) {
    let title = login.title;
    if (!title) {
      try {
        title = new URL(login.origin).hostname.replace(SUBDOMAIN, "");
      } catch {
        title = login.origin ?? "";
      }
    }
    send("ShowLoginItemError", {
      login: { ...login, title },
      errorMessage: error.message,
      existingLoginGuid: error.existingLoginGuid,
    });
  }

  /* ::::: AboutLoginsUtils (Firefox's child actor puts this on window) ::::: */

  window.AboutLoginsUtils = {
    doLoginsMatch(a, b) {
      return a.origin == b.origin && a.username == b.username && a.password == b.password;
    },
    getLoginOrigin(uri) {
      try {
        const url = new URL(uri.includes("://") ? uri : `https://${uri}`);
        return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
      } catch {
        return null;
      }
    },
    setFocus(element) {
      element.focus();
    },
    // Called before revealing, copying or editing a password: decrypt the
    // selected entry now (pinentry may ask, like Firefox's OS auth).
    async promptForPrimaryPassword(resolve) {
      const item = loginItem();
      const login = item?._login;
      if (!login?.guid || login.password != CONCEALED) {
        resolve(true);
        return;
      }
      try {
        const details = await call("manager-get", { path: login.guid });
        const updated = { ...login, password: details.password, username: details.username ?? login.username };
        if (details.url) {
          try {
            updated.origin = updated.formActionOrigin = new URL(details.url).origin;
          } catch {}
        }
        // Update the item and the list's copy in place: setLogin() or a list
        // re-render would reset the reveal box the user just ticked.
        item._login = updated;
        item.render();
        const listed = loginList()?._logins[login.guid];
        if (listed) {
          listed.login = updated;
        }
        resolve(true);
      } catch (error) {
        showError(login, error);
        resolve(false);
      }
    },
    primaryPasswordEnabled: true,
    passwordRevealVisible: true,
    importVisible: false,
    supportBaseURL: HELP_URL,
  };

  /* ::::: page → pass ::::: */

  async function setup() {
    const [{ loginsSort = "name" }, { managerSelect = null }] = await Promise.all([
      browser.storage.local.get("loginsSort"),
      browser.storage.session.get("managerSelect"),
    ]);
    browser.storage.session.remove("managerSelect");
    let logins = [];
    try {
      logins = (await call("manager-list")).map(entry => toLogin(entry));
    } catch (error) {
      document.body.dataset.passfoxError = error.message;
    }
    send("Setup", {
      logins,
      selectedSort: loginsSort,
      syncState: { loggedIn: false },
      primaryPasswordEnabled: true,
      passwordRevealVisible: true,
      importVisible: false,
      preselectedLogin: managerSelect,
    });
  }

  async function copy(value) {
    const login = loginItem()?._login;
    if (login?.guid && value === login.password) {
      // Passwords go through `pass show -c`, which clears the clipboard.
      await call("copy", { path: login.guid, field: "password" });
    } else {
      await navigator.clipboard.writeText(value);
    }
  }

  async function create(login) {
    try {
      const entry = await call("manager-create", login);
      const added = toLogin(entry, { password: login.password, username: login.username, url: login.origin });
      send("LoginAdded", added);
      selectLogin(added);
    } catch (error) {
      showError(login, error);
    }
  }

  async function update(login) {
    const old = loginList()?._logins[login.guid]?.login;
    if (login.password === CONCEALED) {
      showError(login, new Error("The password wasn't loaded; nothing was changed."));
      return;
    }
    try {
      const entry = await call("manager-update", { path: login.guid, ...login });
      const updated = toLogin(entry, { password: login.password, username: login.username, url: login.origin });
      if (entry.path == login.guid) {
        send("LoginModified", updated);
      } else {
        // A new site or username renamed the entry.
        send("LoginRemoved", old ?? { guid: login.guid });
        send("LoginAdded", updated);
        selectLogin(updated);
      }
    } catch (error) {
      showError(old ?? login, error);
    }
  }

  async function remove(login) {
    try {
      await call("manager-remove", { path: login.guid });
      send("LoginRemoved", login);
    } catch (error) {
      showError(login, error);
    }
  }

  function selectLogin(login) {
    window.dispatchEvent(new CustomEvent("AboutLoginsLoginSelected", { detail: login, cancelable: true }));
  }

  const handlers = {
    AboutLoginsInit: setup,
    AboutLoginsCopyLoginDetail: event => copy(event.detail),
    AboutLoginsCreateLogin: event => create(event.detail),
    AboutLoginsUpdateLogin: event => update(event.detail),
    AboutLoginsDeleteLogin: event => remove(event.detail),
    AboutLoginsSortChanged: event => browser.storage.local.set({ loginsSort: event.detail }),
    AboutLoginsGetHelp: () => window.open(HELP_URL, "_blank"),
    // Firefox's "Settings" opens its password settings; passfox's are its
    // preferences in about:addons.
    AboutLoginsOpenPreferences: () => browser.runtime.openOptionsPage(),
  };
  for (const [name, handler] of Object.entries(handlers)) {
    document.addEventListener(name, event => {
      Promise.resolve(handler(event)).catch(error => console.error("passfox:", error));
    });
  }

  // "Manage Passwords" or the edit pencil while this page is already open.
  browser.runtime.onMessage.addListener(msg => {
    if (msg?.type == "select-login" && msg.select) {
      loginList()?.selectLoginByDomainOrGuid(msg.select);
    }
    return undefined;
  });
})();
