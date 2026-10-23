/* Load passfox's content scripts into any page served from the project root,
 * with a fake extension API (same as harness.html). For example, with
 * `python3 -m http.server -d . 8765` running, open
 * http://localhost:8765/test/pages/hostile.html and run in the console:
 *   const s = document.createElement("script"); s.src = "/test/inject.js"; document.head.append(s);
 */
(async () => {
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (options) {
    return (window.passfoxShadow = attachShadow.call(this, { ...options, mode: "open" }));
  };
  const listeners = [];
  const logins = [
    { path: "www/localhost/alice@example.com", domain: "localhost", username: "alice@example.com", exact: true, modified: 1790000000000 },
    { path: "www/localhost/bob", domain: "localhost", username: "bob", exact: true, modified: 1790000000000 },
    { path: "www/localhost/work/bob", domain: "localhost", username: "bob", exact: true, modified: 1760000000000 },
    { path: "www/localhost/pin", domain: "localhost", username: "", exact: true, modified: 1770000000000 },
  ];
  window.browser = {
    runtime: {
      onMessage: { addListener: fn => listeners.push(fn) },
      async sendMessage(msg) {
        switch (msg.type) {
          case "css": {
            const files = ["vendor/firefox/tokens-shared.css", "vendor/firefox/tokens-platform.css", "shared/firefox.css"];
            const texts = await Promise.all(files.map(f => fetch(`/extension/${f}`, { cache: "no-store" }).then(r => r.text())));
            return { result: texts.join("\n") };
          }
          case "logins": return { result: logins };
          case "fill": return { result: { path: msg.path, username: msg.path.split("/").at(-1), password: "correct horse" } };
          case "generate":
            return { result: { path: "www/localhost/passfox-generated-20261023-120000", username: "", password: "Kq7#xR2!mVb9-Lp" } };
          case "submitted":
            setTimeout(() => listeners.forEach(fn => fn({ type: "show-save", pending: {
              mode: msg.filledPath?.includes("passfox-generated-") && msg.password === msg.filledPassword ? "add-username" : "save", host: location.hostname, username: msg.username, password: msg.password,
              usernameSuggestions: [...new Set([...msg.possibleUsernames, ...logins.map(l => l.username)].filter(Boolean))] } })), 0);
            return { result: null };
          case "pending": return { result: null };
          default: return { result: { ok: true } };
        }
      },
    },
  };
  for (const src of ["shared/icons.js", "content/ui.js", "shared/doorhanger.js", "content/autofill.js", "content/save-prompt.js"]) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `/extension/${src}?${Date.now()}`;
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  }
})();
