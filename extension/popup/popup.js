"use strict";

const list = document.getElementById("list");
const search = document.getElementById("search");
const message = document.getElementById("message");
let entries = [];
let tab = null;

async function call(type, data = {}) {
  const reply = await browser.runtime.sendMessage({ type, ...data });
  if (reply?.error) {
    throw new Error(reply.error);
  }
  return reply?.result;
}

function icon(name, className = "") {
  const svg = new DOMParser().parseFromString(PASSFOX_ICONS[name], "image/svg+xml").documentElement;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  return document.importNode(svg, true);
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  node.append(...children);
  return node;
}

function showMessage(text) {
  message.textContent = text;
  message.hidden = !text;
}

function labelsFor(entry) {
  const name = entry.username || "No username";
  const where = entry.exact ? "From this website" : entry.domain;
  return { name, where };
}

function copyButton(entry, field, description) {
  const title = field == "username" ? "Copy username" : "Copy password";
  const button = el("button", "moz-button icon ghost", icon(field == "username" ? "edit-copy" : "login"));
  button.title = title;
  button.tabIndex = -1;
  button.addEventListener("click", async e => {
    e.stopPropagation();
    try {
      await call("copy", { path: entry.path, field });
      const original = description.textContent;
      description.textContent = field == "username" ? "Username copied" : "Password copied";
      setTimeout(() => (description.textContent = original), 2000);
    } catch (error) {
      showMessage(error.message);
    }
  });
  return button;
}

function row(entry) {
  const { name, where } = labelsFor(entry);
  const description = el("span", "description", where ?? "");
  const button = el(
    "div",
    "subviewbutton",
    icon("defaultFavicon", "icon"),
    el("span", "labels-container", el("span", "label", name), description),
    copyButton(entry, "username", description),
    copyButton(entry, "password", description)
  );
  button.setAttribute("role", "option");
  button.tabIndex = 0;
  button.addEventListener("keydown", e => {
    if (e.key == "Enter" || e.key == " ") {
      e.preventDefault();
      button.click();
    }
  });
  button.title = `Fill ${name}`;
  button.addEventListener("click", async () => {
    try {
      await call("fill", { tabId: tab.id, path: entry.path });
      window.close();
    } catch (error) {
      showMessage(error.message);
    }
  });
  return button;
}

function render() {
  const query = search.value.trim().toLowerCase();
  const shown = entries.filter(
    e => !query || `${e.path} ${e.username} ${e.domain ?? ""}`.toLowerCase().includes(query)
  );
  list.replaceChildren(...shown.map(row));
  list.hidden = !shown.length;
  if (!entries.length) {
    showMessage("No saved passwords for this website");
  } else {
    showMessage(shown.length ? "" : "No passwords found");
  }
}

/**
 * While a save is pending for this tab the toolbar panel is the doorhanger,
 * so it hangs from the passfox button the way Firefox's hangs from its key
 * icon. Firefox draws the panel frame, so the doorhanger goes in unframed.
 */
async function showDoorhanger(pending) {
  document.documentElement.setAttribute("view", "doorhanger");
  const finish = async (action, username, password) => {
    await call("pendingDone", { action, username, password, tabId: tab.id });
    window.close();
  };
  // The Never-save menu and username list are drawn inside this document,
  // so grow the panel while one is open instead of clipping it.
  const onLayer = (layer, open) => {
    document.body.style.minHeight = open
      ? `${Math.ceil(layer.getBoundingClientRect().bottom) + 4}px`
      : "";
  };
  // Esc just hides the panel; the save stays pending, so the toolbar button
  // brings it back (like Firefox's dismissed doorhanger and its key icon).
  const { panel, layers } = PassfoxDoorhanger.build(pending, {
    finish,
    onLayer,
    onEscape: () => window.close(),
    nativeMenu: true,
  });
  document.querySelector(".panelview").replaceWith(panel);
  document.body.append(...layers);
}

async function init() {
  document.documentElement.setAttribute("view", "site");
  document.querySelector(".search").prepend(icon("search-textbox"));
  document.getElementById("manage").addEventListener("click", async () => {
    // Opens the passwords page on this site, like Firefox's about:logins.
    let select = null;
    try {
      select = new URL(tab?.url).hostname || null;
    } catch {}
    await call("openManager", { select });
    window.close();
  });
  search.addEventListener("input", render);

  try {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const pending = await call("pending", { tabId: tab.id });
    if (pending) {
      await showDoorhanger(pending);
      return;
    }
    entries = await call("logins", { tabId: tab.id });
    render();
  } catch (error) {
    list.hidden = true;
    showMessage(
      /native|host|No such/i.test(error.message)
        ? "Can't reach pass. Run install.sh from the passfox folder, then reopen this panel."
        : error.message
    );
  }
  search.focus();
}

init();
