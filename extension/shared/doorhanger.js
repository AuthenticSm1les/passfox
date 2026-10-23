"use strict";

/* The "Save password for host?" / "Update password for host?" doorhanger
 * (Firefox's #password-notification). Built here, shown either in a toolbar
 * panel (popup/save.html) or, as a fallback, inside the page. */
var PassfoxDoorhanger = (() => {
  const { el, icon } = PassfoxUI;

  function field(id, label, input) {
    return el(
      "div",
      { class: "moz-input login-doorhanger-field" },
      el("label", { for: id }, label),
      input
    );
  }

  /**
   * @param {object} pending  The pending save from the background.
   * @param {object} options
   * @param {Function} options.finish  async (action, username, password); throws to show an error.
   * @param {boolean} [options.framed]  Draw the panel frame ourselves (in-page).
   * @param {Function} [options.onLayer]  (element, open) when a menu or list opens/closes.
   * @param {Function} [options.onEscape]  Esc with nothing open; defaults to "Not now".
   * @param {boolean} [options.nativeMenu]  Open "Never save" and the username
   *   list as native popups that can extend past the document (needed inside
   *   the toolbar panel).
   * @returns {{ panel: Element, layers: Element[] }}
   */
  function build(pending, { finish, framed = false, onLayer = () => {}, onEscape = null, nativeMenu = false }) {
    let mode = pending.mode;

    const description = el("p", { class: "description", id: "pf-desc" });
    const username = el("input", {
      id: "pf-username",
      type: "text",
      placeholder: "No username",
      autocomplete: "off",
      spellcheck: "false",
    });
    username.value = pending.username;
    const password = el("input", { id: "pf-password", type: "password", autocomplete: "off" });
    password.value = pending.password;

    // login-doorhanger-username-field: a dropmarker opens saved and seen
    // usernames when there are any.
    const suggestions = pending.usernameSuggestions ?? [];
    const dropmarker = el("span", { class: "ac-dropmarker", hidden: !suggestions.length }, icon("arrow-down-12"));
    const usernameBox = el(
      "div",
      { class: `autocomplete-container${suggestions.length ? " has-dropmarker" : ""}` },
      username,
      dropmarker
    );
    // Same <select> trick as "Never save" below: its native dropdown sits
    // under the field like the PopupAutoComplete the dropmarker opens.
    const usernameSelect =
      nativeMenu && suggestions.length
        ? el(
            "select",
            { class: "native-menu", tabindex: "-1", "aria-hidden": "true" },
            el("option", { value: "", hidden: true, selected: true }),
            ...suggestions.map(text => el("option", { value: text }, text))
          )
        : null;
    if (usernameSelect) {
      usernameBox.append(usernameSelect);
      usernameSelect.addEventListener("change", () => {
        const text = usernameSelect.value;
        usernameSelect.value = "";
        if (text) {
          username.value = text;
          username.dispatchEvent(new Event("input"));
        }
        username.focus();
      });
    }
    const suggestList = el("div", { class: "richlistbox", role: "listbox" });
    const suggest = el("div", { class: "panel autocomplete", hidden: true }, suggestList);
    let suggestRows = [];
    let suggestIndex = -1;

    // The reveal button Firefox draws inside chrome password inputs
    // (forms.css ::-moz-reveal): eye when masked, eye-slash when shown.
    const reveal = el("button", { class: "reveal", type: "button", tabindex: "-1", title: "Show password" });
    const passwordBox = el("div", { class: "reveal-container" }, password, reveal);
    function renderReveal() {
      const shown = password.type == "text";
      reveal.replaceChildren(icon(shown ? "eye-slash" : "eye"));
      reveal.title = shown ? "Hide password" : "Show password";
      reveal.hidden = !password.value;
    }
    const warning = el("p", {
      class: "description",
      hidden: true,
      style: "color: var(--text-color-error); margin-top: var(--space-small)",
    });

    const primary = el("button", { class: "moz-button", type: "primary" });
    const notNow = el("button", { class: "moz-button main" }, "Not now");
    const chevron = el(
      "button",
      { class: "moz-button chevron", "aria-haspopup": "menu", "aria-expanded": "false", title: "More actions" },
      icon("arrow-down-12")
    );
    const split = el("div", { class: "split-button" }, notNow, chevron);
    // A <select>'s dropdown is the one native popup a page can open: Firefox
    // draws it as a real menu, so it floats outside the toolbar panel the way
    // the doorhanger's XUL menupopup does instead of stretching the panel.
    const nativeSelect = nativeMenu
      ? el(
          "select",
          { class: "native-menu", tabindex: "-1", "aria-hidden": "true" },
          el("option", { value: "", hidden: true, selected: true }),
          el("option", { value: "never" }, "Never save")
        )
      : null;
    if (nativeSelect) {
      split.append(nativeSelect);
    }
    const neverSave = el("div", { class: "menuitem", role: "menuitem", tabindex: "-1" }, "Never save");
    const menu = el("div", { class: "panel menu", role: "menu", hidden: true }, neverSave);

    function render() {
      const save = mode == "save";
      description.replaceChildren(
        save ? `Save password for ${pending.host}?` : `Update password for ${pending.host}?`
      );
      primary.replaceChildren(save ? "Save" : "Update");
      // Firefox only offers "Never save" for new logins.
      chevron.hidden = !save;
      notNow.classList.toggle("main", save);
      primary.disabled = !password.value;
    }

    const panel = el(
      "div",
      { class: `${framed ? "panel " : ""}doorhanger`, role: "dialog", "aria-labelledby": "pf-desc" },
      el(
        "div",
        { class: "body-container" },
        icon("login", "notification-icon"),
        el(
          "div",
          { class: "notification-body" },
          description,
          el(
            "div",
            { class: "content" },
            field("pf-username", "Username", usernameBox),
            field("pf-password", "Password", passwordBox)
          ),
          warning
        )
      ),
      el("div", { class: "moz-button-group panel-footer" }, split, primary)
    );

    async function done(action, ...values) {
      try {
        await finish(action, ...values);
      } catch (error) {
        warning.replaceChildren(error.message);
        warning.hidden = false;
      }
    }

    const values = () => [username.value.trim(), password.value];
    primary.addEventListener("click", () => done(mode, ...values()));
    notNow.addEventListener("click", () => done("dismiss"));
    neverSave.addEventListener("click", () => done("never"));

    function setMenu(open) {
      menu.hidden = !open;
      chevron.setAttribute("aria-expanded", String(open));
      if (open) {
        const r = chevron.getBoundingClientRect();
        menu.style.top = `${r.bottom}px`;
        menu.style.left = `${r.right - menu.offsetWidth}px`;
        neverSave.focus();
      }
      onLayer(menu, open);
    }
    chevron.addEventListener("click", () => {
      if (nativeSelect) {
        try {
          nativeSelect.showPicker();
          return;
        } catch {
          // Fall through to the in-document menu.
        }
      }
      setMenu(menu.hidden);
    });
    nativeSelect?.addEventListener("change", () => {
      const action = nativeSelect.value;
      nativeSelect.value = "";
      if (action == "never") {
        done("never");
      }
    });

    username.addEventListener("input", () => {
      // Changing the username of an update turns it into a new login.
      mode = pending.mode == "update" && username.value.trim() !== pending.username ? "save" : pending.mode;
      render();
    });
    password.addEventListener("input", () => {
      render();
      renderReveal();
    });
    reveal.addEventListener("mousedown", e => e.preventDefault());
    reveal.addEventListener("click", () => {
      password.type = password.type == "password" ? "text" : "password";
      renderReveal();
    });

    function selectSuggestion(index) {
      suggestIndex = index;
      suggestRows.forEach((row, i) => {
        row.toggleAttribute("selected", i === index);
        row.firstChild.toggleAttribute("selected", i === index);
      });
    }
    function closeSuggest() {
      if (!suggest.hidden) {
        suggest.hidden = true;
        suggestIndex = -1;
        onLayer(suggest, false);
      }
    }
    function pickSuggestion(text) {
      username.value = text;
      username.dispatchEvent(new Event("input"));
      closeSuggest();
    }
    function openSuggest() {
      if (usernameSelect) {
        try {
          usernameSelect.showPicker();
          return;
        } catch {
          // Fall through to the in-document list.
        }
      }
      suggestRows = suggestions.map(text => {
        const row = el(
          "div",
          { class: "richlistitem", role: "option" },
          el(
            "div",
            { class: "row-item-host" },
            el("div", { class: "row-item" }, el("div", { class: "labels-container" }, el("span", { class: "label" }, text)))
          )
        );
        row.addEventListener("mousedown", e => e.preventDefault());
        row.addEventListener("click", () => pickSuggestion(text));
        return row;
      });
      suggestList.replaceChildren(...suggestRows);
      suggest.hidden = false;
      const r = username.getBoundingClientRect();
      suggest.style.minWidth = `${Math.max(r.width, 250)}px`;
      suggest.style.top = `${r.bottom}px`;
      suggest.style.left = `${r.left}px`;
      selectSuggestion(-1);
      onLayer(suggest, true);
    }
    dropmarker.addEventListener("mousedown", e => e.preventDefault());
    dropmarker.addEventListener("click", () => {
      username.focus();
      if (suggest.hidden) {
        openSuggest();
      } else {
        closeSuggest();
      }
    });
    username.addEventListener("blur", closeSuggest);
    username.addEventListener("keydown", e => {
      if (!suggestions.length || !["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) {
        return;
      }
      if (suggest.hidden) {
        if (e.key == "ArrowDown") {
          e.preventDefault();
          openSuggest();
        }
        return;
      }
      if (e.key == "Enter") {
        if (suggestIndex >= 0) {
          e.preventDefault();
          e.stopPropagation();
          pickSuggestion(suggestions[suggestIndex]);
        }
        return;
      }
      e.preventDefault();
      const count = suggestRows.length;
      let next = suggestIndex + (e.key == "ArrowDown" ? 1 : -1);
      if (next >= count) {
        next = -1;
      } else if (next < -1) {
        next = count - 1;
      }
      selectSuggestion(next);
    });

    panel.addEventListener("keydown", e => {
      if (e.key == "Escape") {
        e.preventDefault();
        if (!suggest.hidden) {
          closeSuggest();
        } else if (!menu.hidden) {
          setMenu(false);
        } else if (onEscape) {
          onEscape();
        } else {
          done("dismiss");
        }
      } else if (e.key == "Enter" && e.target.localName == "input" && !primary.disabled) {
        e.preventDefault();
        done(mode, ...values());
      }
    });

    render();
    renderReveal();
    return { panel, layers: [menu, suggest] };
  }

  return { build };
})();
