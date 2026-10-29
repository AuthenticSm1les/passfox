"use strict";

/* In-page fallback for the save doorhanger, used when the toolbar panel
 * can't be opened (see background.js). Top frame only. */
(() => {
  if (window !== window.top) {
    return;
  }
  const { call, root } = PassfoxUI;

  let current = null; // { panel, layers, outside }

  function close() {
    if (!current) {
      return;
    }
    current.panel.remove();
    current.layers.forEach(layer => layer.remove());
    document.removeEventListener("mousedown", current.outside, true);
    current = null;
  }

  async function show(pending) {
    const shadow = await root();
    close();
    const finish = async (action, username, password) => {
      await call("pendingDone", { action, username, password });
      close();
    };
    const { panel, layers } = PassfoxDoorhanger.build(pending, { finish, framed: true });
    panel.style.top = "0";
    panel.style.insetInlineStart = "var(--space-small)";

    // Clicking into the page dismisses the doorhanger, like any Firefox panel.
    // (The shadow root is closed, so from document we only see its host.)
    const outside = e => {
      if (!e.composedPath().includes(shadow.host)) {
        finish("dismiss").catch(() => {});
      }
    };
    document.addEventListener("mousedown", outside, true);

    // Arrow-panel entrance (popup.css panel[type="arrow"] transition).
    panel.classList.add("opening");
    shadow.append(panel, ...layers);
    current = { panel, layers, outside };
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.remove("opening")));
  }

  browser.runtime.onMessage.addListener(msg => {
    if (msg?.type == "show-save") {
      show(msg.pending);
    }
    return undefined;
  });

  // After a form post the page reloads; re-show a pending in-page prompt.
  // Only ask the background when one is waiting for this site.
  browser.storage.local
    .get("inPageSaves")
    .then(({ inPageSaves = {} }) => {
      const host = location.hostname;
      const waiting = Object.values(inPageSaves).some(
        ({ domain, until }) => until > Date.now() && (host == domain || host.endsWith(`.${domain}`))
      );
      return waiting ? call("pending") : null;
    })
    .then(pending => pending?.inPage && show(pending))
    .catch(() => {});
})();
