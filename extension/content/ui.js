"use strict";

/* Shared helpers for passfox's in-page surfaces: one closed shadow root on
 * <html> that holds the autocomplete popup and the save doorhanger. */
var PassfoxUI = (() => {
  let rootPromise = null;

  async function call(type, data = {}) {
    const reply = await browser.runtime.sendMessage({ type, ...data });
    if (reply?.error) {
      throw new Error(reply.error);
    }
    return reply?.result;
  }

  function applyStyles(shadow, cssText) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement("style");
      style.textContent = cssText;
      shadow.append(style);
    }
  }

  async function createRoot() {
    const cssText = await call("css");
    const host = document.createElement("passfox-ui");
    host.className = "anonymous-content-host";
    const shadow = host.attachShadow({ mode: "closed" });
    applyStyles(shadow, cssText);
    document.documentElement.append(host);
    // Firefox's tokens are sized in rem of the browser UI font; pin that here
    // so the page's own root font size can't rescale the popup.
    host.style.setProperty("--passfox-rem", getComputedStyle(host).fontSize);
    return shadow;
  }

  function root() {
    rootPromise ??= createRoot();
    return rootPromise;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value === false || value == null) {
        continue;
      }
      if (name == "class") {
        node.className = value;
      } else if (name.startsWith("on")) {
        node.addEventListener(name.slice(2), value);
      } else {
        node.setAttribute(name, value === true ? "" : value);
      }
    }
    node.append(...children.filter(c => c != null));
    return node;
  }

  function icon(name, className = "") {
    const svg = new DOMParser().parseFromString(
      globalThis.PASSFOX_ICONS[name],
      "image/svg+xml"
    ).documentElement;
    const node = document.importNode(svg, true);
    node.setAttribute("aria-hidden", "true");
    if (className) {
      node.setAttribute("class", className);
    }
    return node;
  }

  function isVisible(node) {
    return !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
  }

  return { call, root, el, icon, isVisible };
})();
