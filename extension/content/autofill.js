"use strict";

/* Login field detection, the #PopupAutoComplete look-alike, filling, and
 * form-submission capture for the save doorhanger. */
(() => {
  const { call, root, el, icon, isVisible } = PassfoxUI;

  const TEXT_TYPES = new Set(["text", "email", "url", "tel", "number", ""]);
  const USERNAME_HINT = /user|login|email|e-mail|identifier|account|signin/i;
  const SUBMIT_TEXT = /log ?in|sign ?in|continue|next|submit|connexion|anmelden/i;
  // Firefox's :autofill highlight (layout/style/res/forms.css).
  const AUTOFILL_STYLE = "background-color: light-dark(rgb(255, 249, 145), rgb(255, 249, 145, 0.2)) !important; background-image: none !important; color: FieldText !important;";

  let logins = null;
  let loginsPromise = null;
  let popup = null; // { panel, list, field, rows, selected }
  let lastFill = null; // { path, password }
  let lastSubmit = { key: "", at: 0 };
  let popupDismissedFor = null;

  // Settings: "Suggest strong passwords".
  let suggestPasswords = true;
  browser.storage.local.get({ suggestPasswords: true }).then(s => (suggestPasswords = s.suggestPasswords));
  browser.storage.onChanged.addListener((changes, area) => {
    if (area == "local" && changes.suggestPasswords) {
      suggestPasswords = changes.suggestPasswords.newValue !== false;
    }
  });

  /* ::::: field detection ::::: */

  function isInput(node) {
    return node?.localName == "input" && !node.disabled && !node.readOnly;
  }

  function isPasswordField(node) {
    return isInput(node) && (node.type == "password" || unmasked.has(node));
  }

  function isTextField(node) {
    return isInput(node) && TEXT_TYPES.has(node.type) && !unmasked.has(node);
  }

  /* ::::: generated-password unmasking ::::: */

  // Firefox shows a filled generated password in clear text while its field
  // has focus (editor.unmask(), chrome-only). A page can only do that by
  // switching the input to type=text, so autocomplete is turned off
  // meanwhile (form history never records it) and fields are masked again
  // before any submit.
  const generatedFields = new WeakMap(); // field -> its current value
  const unmasked = new Map(); // field -> its own autocomplete attribute

  function unmask(field) {
    if (unmasked.has(field) || field.type != "password") {
      return;
    }
    unmasked.set(field, field.getAttribute("autocomplete"));
    field.setAttribute("autocomplete", "off");
    field.type = "text";
  }

  function mask(field) {
    if (!unmasked.has(field)) {
      return;
    }
    const autocomplete = unmasked.get(field);
    unmasked.delete(field);
    if (field.type == "text") {
      field.type = "password";
    }
    if (autocomplete == null) {
      field.removeAttribute("autocomplete");
    } else {
      field.setAttribute("autocomplete", autocomplete);
    }
  }

  function maskAll() {
    [...unmasked.keys()].forEach(mask);
  }

  function treatAsGenerated(field) {
    if (!field) {
      return;
    }
    generatedFields.set(field, field.value);
    if (document.activeElement === field) {
      unmask(field);
    }
  }

  // Like _doesEventClearPrevFieldValue: an edit that replaces the whole
  // value (rather than adding to or trimming it) ends the special handling.
  function replacedValue(previous, value) {
    if (!value) {
      return true;
    }
    let prefix = 0;
    while (prefix < previous.length && previous[prefix] === value[prefix]) {
      prefix++;
    }
    return prefix == 0 && !value.endsWith(previous.at(-1) ?? "");
  }

  function scopeOf(node) {
    return node.form ?? node.closest("form") ?? node.ownerDocument;
  }

  function precedes(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function visibleInputs(scope, predicate) {
    return [...scope.querySelectorAll("input")].filter(i => predicate(i) && isVisible(i));
  }

  /** The text field just before the first password field, like Firefox. */
  function usernameFieldFor(passwordField) {
    const candidates = visibleInputs(scopeOf(passwordField), isTextField).filter(i =>
      precedes(i, passwordField)
    );
    return candidates.at(-1) ?? null;
  }

  function passwordFieldFor(usernameField) {
    return (
      visibleInputs(scopeOf(usernameField), isPasswordField).find(p =>
        precedes(usernameField, p)
      ) ?? null
    );
  }

  function isUsernameField(node) {
    if (!isTextField(node)) {
      return false;
    }
    const autocomplete = (node.autocomplete || "").toLowerCase();
    if (/\b(username|email)\b/.test(autocomplete)) {
      return true;
    }
    if (/\b(off|one-time-code|cc-|new-password)/.test(autocomplete)) {
      return false;
    }
    const password = passwordFieldFor(node);
    if (password) {
      return usernameFieldFor(password) === node;
    }
    // Identifier-first pages (username now, password on the next step).
    return USERNAME_HINT.test(`${node.name} ${node.id}`) && node.form != null;
  }

  function isLoginField(node) {
    return isPasswordField(node) || isUsernameField(node);
  }

  // A light stand-in for Firefox's Fathom new-password model: an explicit
  // autocomplete="new-password", or the new password of a sign-up form
  // (password, confirm) or a change form (current, new, confirm).
  function isNewPasswordField(node) {
    if (!isPasswordField(node)) {
      return false;
    }
    const autocomplete = (node.autocomplete || "").toLowerCase();
    if (/\bnew-password\b/.test(autocomplete)) {
      return true;
    }
    if (/\bcurrent-password\b/.test(autocomplete)) {
      return false;
    }
    const passwords = visibleInputs(scopeOf(node), isPasswordField);
    const index = passwords.indexOf(node);
    return (passwords.length == 2 && index == 0) || (passwords.length == 3 && index == 1);
  }

  /* ::::: logins ::::: */

  async function getLogins() {
    if (logins) {
      return logins;
    }
    loginsPromise ??= call("logins")
      .then(result => (logins = result ?? []))
      .catch(error => {
        console.warn("passfox:", error.message);
        loginsPromise = null;
        return [];
      });
    return loginsPromise;
  }

  function matchesFor(field) {
    const value = field.value.toLowerCase();
    if (isPasswordField(field) || !value) {
      return logins;
    }
    return logins.filter(l => l.username.toLowerCase().startsWith(value));
  }

  /* ::::: popup ::::: */

  const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

  /** Like LoginAutocompleteItem: empty or repeated usernames get a date. */
  function loginLabel(login, all) {
    const duplicate =
      login.username && all.filter(l => l.username === login.username).length > 1;
    const name = login.username || "No username";
    if ((!login.username || duplicate) && login.modified) {
      return `${name} (${dateFormatter.format(new Date(login.modified))})`;
    }
    return name;
  }

  function faviconUrl() {
    const link = document.querySelector('link[rel~="icon"][href]');
    try {
      return new URL(link?.getAttribute("href") ?? "/favicon.ico", document.baseURI).href;
    } catch {
      return null;
    }
  }

  // Resolved once per page (like Firefox's page-icon cache), so reopening the
  // popup doesn't refetch a missing favicon every time.
  let faviconPromise = null;

  function loadFavicon() {
    faviconPromise ??= new Promise(resolve => {
      const url = faviconUrl();
      if (!url) {
        resolve(null);
        return;
      }
      const probe = new Image();
      probe.onload = () => resolve(url);
      probe.onerror = () => resolve(null);
      probe.src = url;
    });
    return faviconPromise;
  }

  async function siteIcons(count) {
    const url = await loadFavicon();
    return Array.from({ length: count }, () =>
      url
        ? el("img", { class: "icon", role: "presentation", src: url, alt: "" })
        : icon("defaultFavicon", "icon")
    );
  }

  function buildRow({ label, description, iconNode, footer, secondary, onActivate }) {
    const rowItem = el(
      "div",
      { class: "row-item" },
      iconNode,
      el(
        "div",
        { class: "labels-container" },
        el("span", { class: "label" }, label),
        description ? el("span", { class: "description" }, description) : null
      ),
      secondary
    );
    const item = el(
      "div",
      { class: "richlistitem", role: "option", footer: footer || null },
      el("div", { class: "row-item-host" }, rowItem)
    );
    item.activate = onActivate;
    return item;
  }

  function editButton(login) {
    const button = el(
      "button",
      { class: "moz-button icon ghost secondary-action", title: "Edit login", tabindex: "-1" },
      icon("edit")
    );
    button.addEventListener("mousedown", e => {
      e.preventDefault();
      e.stopPropagation();
    });
    button.addEventListener("click", e => {
      e.stopPropagation();
      closePopup();
      call("openManager", { select: login.path });
    });
    return button;
  }

  function setSelected(index, { pointer = false } = {}) {
    if (!popup) {
      return;
    }
    popup.selected = index;
    popup.list.toggleAttribute("pointerselected", pointer);
    popup.rows.forEach((row, i) => {
      const on = i === index;
      row.toggleAttribute("selected", on);
      row.firstChild.toggleAttribute("selected", on);
      row.firstChild.toggleAttribute("pointerselected", on && pointer);
      row.setAttribute("aria-selected", String(on));
    });
    popup.rows[index]?.scrollIntoView({ block: "nearest" });
  }

  function positionPopup() {
    if (!popup?.field) {
      return;
    }
    const { field, panel } = popup;
    const rect = field.getBoundingClientRect();
    if (!isVisible(field) || rect.bottom < 0 || rect.top > innerHeight) {
      closePopup();
      return;
    }
    panel.style.minWidth = `${Math.max(rect.width, 250)}px`;
    const height = panel.offsetHeight;
    const below = innerHeight - rect.bottom;
    const top = below < height && rect.top > below ? rect.top - height : rect.bottom;
    const left = Math.min(rect.left, innerWidth - panel.offsetWidth - 4);
    panel.style.top = `${Math.max(0, top)}px`;
    panel.style.left = `${Math.max(0, left)}px`;
  }

  async function openPopup(field) {
    await getLogins();
    if (document.activeElement !== field) {
      return;
    }
    const offerGenerated = suggestPasswords && isNewPasswordField(field) && !field.value;
    const matches = matchesFor(field);
    const showFooter = offerGenerated || !(isPasswordField(field) && field.value);
    if (!matches.length && !offerGenerated) {
      closePopup();
      return;
    }

    const icons = await siteIcons(matches.length);
    const rows = matches.map((login, i) =>
      buildRow({
        label: loginLabel(login, matches),
        description: login.exact ? "From this website" : login.domain,
        iconNode: icons[i],
        secondary: editButton(login),
        onActivate: () => fillFrom(login, field),
      })
    );
    if (offerGenerated) {
      rows.push(
        buildRow({
          label: "Use a Securely Generated Password",
          description: "passfox will save this password for this website.",
          iconNode: icon("login", "icon"),
          onActivate: () => fillGenerated(field),
        })
      );
    }
    if (showFooter) {
      rows.push(
        buildRow({
          label: "Manage Passwords",
          footer: true,
          onActivate: () => call("openManager", {}),
        })
      );
    }

    const shadow = await root();
    if (!popup) {
      const list = el("div", { class: "richlistbox", role: "listbox" });
      const panel = el("div", { class: "panel autocomplete", role: "presentation" }, list);
      // Keep focus in the page field while the popup is used, as Firefox does.
      panel.addEventListener("mousedown", e => e.preventDefault());
      panel.addEventListener("mousemove", e => {
        const index = popup?.rows.indexOf(e.target.closest?.(".richlistitem"));
        if (index >= 0 && (index !== popup.selected || !popup.list.hasAttribute("pointerselected"))) {
          setSelected(index, { pointer: true });
        }
      });
      panel.addEventListener("click", e => {
        const row = e.target.closest?.(".richlistitem");
        if (row && e.button === 0) {
          closePopup();
          row.activate();
        }
      });
      shadow.append(panel);
      popup = { panel, list };
    }
    popup.field = field;
    popup.rows = rows;
    popup.list.replaceChildren(...rows);
    popup.list.style.maxHeight = "";
    popup.panel.hidden = false;
    setSelected(-1);
    positionPopup();
  }

  function closePopup() {
    if (popup) {
      popup.panel.hidden = true;
      popup.field = null;
      popup.selected = -1;
    }
  }

  function popupOpenFor(field) {
    return popup && !popup.panel.hidden && popup.field === field;
  }

  /* ::::: filling ::::: */

  function setValue(field, value) {
    if (!field) {
      return;
    }
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    highlight(field);
  }

  function highlight(field) {
    const previous = field.getAttribute("style") ?? "";
    field.setAttribute("style", `${previous};${AUTOFILL_STYLE}`);
    const clear = () => {
      if (previous) {
        field.setAttribute("style", previous);
      } else {
        field.removeAttribute("style");
      }
    };
    field.addEventListener("input", e => e.isTrusted && clear(), { once: true });
  }

  function fillLogin(login, field) {
    let usernameField;
    let passwordField;
    if (isPasswordField(field)) {
      passwordField = field;
      usernameField = usernameFieldFor(field);
    } else {
      usernameField = field;
      passwordField = passwordFieldFor(field);
    }
    if (usernameField && login.username) {
      setValue(usernameField, login.username);
    }
    if (passwordField) {
      setValue(passwordField, login.password);
    }
    lastFill = { path: login.path, password: login.password };
  }

  async function fillFrom(entry, field) {
    try {
      fillLogin(await call("fill", { path: entry.path }), field);
    } catch (error) {
      console.warn("passfox:", error.message);
    }
  }

  // pass generates and stores the password; fill it and its confirmation.
  async function fillGenerated(field) {
    try {
      const login = await call("generate");
      setValue(field, login.password);
      const confirm = visibleInputs(scopeOf(field), isPasswordField).find(
        p => p !== field && precedes(field, p) && !p.value
      );
      setValue(confirm, login.password);
      treatAsGenerated(field);
      treatAsGenerated(confirm);
      lastFill = { path: login.path, password: login.password };
      logins = null;
      loginsPromise = null;
    } catch (error) {
      console.warn("passfox:", error.message);
    }
  }

  // Fill requests from the toolbar popup: use the focused login field, or the
  // first visible one on the page.
  browser.runtime.onMessage.addListener(msg => {
    if (msg?.type != "fill") {
      return undefined;
    }
    const active = document.activeElement;
    const target = isLoginField(active)
      ? active
      : visibleInputs(document, isPasswordField)[0] ??
        visibleInputs(document, isUsernameField)[0];
    if (target) {
      fillLogin(msg.login, target);
    }
    return Promise.resolve(!!target);
  });

  /* ::::: events ::::: */

  document.addEventListener(
    "focusin",
    e => {
      const field = e.composedPath()[0];
      if (generatedFields.has(field)) {
        unmask(field);
        return;
      }
      if (isLoginField(field) && popupDismissedFor !== field) {
        openPopup(field);
      }
    },
    true
  );

  document.addEventListener(
    "focusout",
    e => {
      const field = e.composedPath()[0];
      mask(field);
      if (popup && field === popup.field) {
        closePopup();
      }
      popupDismissedFor = null;
    },
    true
  );

  document.addEventListener(
    "mousedown",
    e => {
      const field = e.composedPath()[0];
      if (e.button !== 0 || !isLoginField(field) || document.activeElement !== field) {
        return;
      }
      if (popupOpenFor(field)) {
        closePopup();
        popupDismissedFor = field;
      } else {
        popupDismissedFor = null;
        openPopup(field);
      }
    },
    true
  );

  document.addEventListener(
    "input",
    e => {
      const field = e.composedPath()[0];
      if (!e.isTrusted || document.activeElement !== field) {
        return;
      }
      if (generatedFields.has(field)) {
        if (replacedValue(generatedFields.get(field), field.value)) {
          generatedFields.delete(field);
          mask(field);
        } else {
          generatedFields.set(field, field.value);
        }
      }
      // Typing a password hides the popup; typing a username filters it.
      if (isPasswordField(field)) {
        closePopup();
      } else if (isUsernameField(field)) {
        openPopup(field);
      }
    },
    true
  );

  document.addEventListener(
    "keydown",
    e => {
      const field = e.composedPath()[0];
      if (!isLoginField(field)) {
        return;
      }
      const open = popupOpenFor(field);
      const count = open ? popup.rows.length : 0;
      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp":
          e.preventDefault();
          if (!open) {
            popupDismissedFor = null;
            openPopup(field);
            return;
          }
          {
            const step = e.key == "ArrowDown" ? 1 : -1;
            let next = popup.selected + step;
            if (next >= count) {
              next = -1;
            } else if (next < -1) {
              next = count - 1;
            }
            setSelected(next);
          }
          return;
        case "Enter":
          if (open && popup.selected >= 0) {
            e.preventDefault();
            e.stopPropagation();
            const row = popup.rows[popup.selected];
            closePopup();
            row.activate();
            return;
          }
          if (isPasswordField(field)) {
            captureSubmit(scopeOf(field));
          }
          return;
        case "Escape":
          if (open) {
            e.preventDefault();
            e.stopPropagation();
            closePopup();
            popupDismissedFor = field;
          }
          return;
        case "Tab":
          closePopup();
          return;
      }
    },
    true
  );

  addEventListener("scroll", () => positionPopup(), { capture: true, passive: true });
  addEventListener("resize", () => positionPopup(), { passive: true });

  /* ::::: submission capture ::::: */

  function credentialsIn(scope) {
    const passwords = visibleInputs(scope, isPasswordField).filter(p => p.value);
    if (!passwords.length) {
      return null;
    }
    // Change-password forms: the new password is the one typed twice.
    let password = passwords.at(-1).value;
    if (passwords.length >= 2) {
      const values = passwords.map(p => p.value);
      password = values.find((v, i) => values.indexOf(v) !== i) ?? password;
    }
    const passwordField = passwords.find(p => p.value === password);
    const usernameField =
      usernameFieldFor(passwordField) ??
      scope.querySelector('input[autocomplete~="username"]');
    // Every filled text field could be the username; the doorhanger's
    // dropmarker offers them, like Firefox's possibleValues.usernames.
    const possibleUsernames = [
      ...new Set(
        visibleInputs(scope, isTextField)
          .map(i => i.value.trim())
          .filter(v => v && v !== password && v.length <= 200)
      ),
    ];
    return { username: usernameField?.value.trim() ?? "", password, possibleUsernames };
  }

  function captureSubmit(scope) {
    maskAll();
    const credentials = credentialsIn(scope);
    if (!credentials) {
      return;
    }
    const key = `${credentials.username}\n${credentials.password}`;
    if (key === lastSubmit.key && Date.now() - lastSubmit.at < 3000) {
      return;
    }
    lastSubmit = { key, at: Date.now() };
    call("submitted", {
      ...credentials,
      filledPath: lastFill?.path,
      filledPassword: lastFill?.password,
    }).catch(error => console.warn("passfox:", error.message));
  }

  document.addEventListener("submit", e => captureSubmit(e.target), true);

  document.addEventListener(
    "click",
    e => {
      const button = e.composedPath()[0]?.closest?.(
        'button, input[type="submit"], input[type="image"], [role="button"]'
      );
      if (!button) {
        return;
      }
      const isSubmit =
        (button.localName == "button" && (button.type == "submit" || !button.getAttribute("type"))) ||
        button.localName == "input" ||
        SUBMIT_TEXT.test(button.textContent ?? "");
      if (isSubmit) {
        captureSubmit(scopeOf(button));
      }
    },
    true
  );
})();
