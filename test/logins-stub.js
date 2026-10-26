/* Fake extension API for running extension/logins/logins.html outside
 * Firefox (made-up logins; nothing touches pass). Serve extension/ with
 * test/serve.py and open /logins/logins.html?stub=logins-stub.js */
(() => {
  // ?delay=MS holds the load event (for headless `firefox --screenshot`).
  const delay = new URL(location.href).searchParams.get("delay");
  if (delay) {
    document.write(`<img src="/delay?ms=${Number(delay)}" hidden>`);
  }
  const entries = [
    { path: "www/github.com/alice", domain: "github.com", username: "alice", modified: 1790000000000 },
    { path: "www/github.com/alice-work", domain: "github.com", username: "alice@work.example", modified: 1785000000000 },
    { path: "www/accounts.example.com/sam", domain: "accounts.example.com", username: "sam", modified: 1770000000000 },
    { path: "www/www.wikipedia.org/alex", domain: "www.wikipedia.org", username: "alex", modified: 1760000000000 },
    { path: "www/Forum/dave", domain: null, username: "dave", modified: 1750000000000 },
  ];
  window.stubLog = [];
  // storage.local, with Firefox's get(defaults) behaviour.
  const local = { neverSave: ["forum.example.org", "shop.example.com"] };
  const changeListeners = [];
  const get = async keys => {
    if (keys && typeof keys == "object" && !Array.isArray(keys)) {
      return { ...keys, ...Object.fromEntries(Object.keys(keys).filter(k => k in local).map(k => [k, local[k]])) };
    }
    const names = keys == null ? Object.keys(local) : [].concat(keys);
    return Object.fromEntries(names.filter(k => k in local).map(k => [k, local[k]]));
  };
  window.browser = {
    runtime: {
      onMessage: { addListener() {} },
      openOptionsPage: async () => stubLog.push({ type: "openOptionsPage" }),
      async sendMessage(msg) {
        stubLog.push(msg);
        switch (msg.type) {
          case "manager-list": return { result: entries };
          case "manager-get": return { result: { password: "correct-horse-" + msg.path.split("/").at(-1), username: null, url: null } };
          case "manager-create":
            if (entries.some(e => e.domain == new URL(msg.origin).hostname && e.username == msg.username)) {
              return { error: "This login already exists.", existingLoginGuid: entries.find(e => e.username == msg.username).path };
            }
            return { result: { path: `www/${new URL(msg.origin).hostname}/${msg.username}`, domain: new URL(msg.origin).hostname, username: msg.username, modified: Date.now() } };
          case "manager-update": {
            const host = new URL(msg.origin).hostname;
            return { result: { path: `www/${host}/${msg.username}`, domain: host, username: msg.username, modified: Date.now() } };
          }
          default: return { result: { ok: true } };
        }
      },
    },
    storage: {
      onChanged: { addListener: fn => changeListeners.push(fn) },
      local: {
        get,
        async set(items) {
          stubLog.push({ type: "storage.set", ...items });
          const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { oldValue: local[k], newValue: v }]));
          Object.assign(local, items);
          changeListeners.forEach(fn => fn(changes, "local"));
        },
      },
      session: { get: async () => ({ managerSelect: new URL(location.href).searchParams.get("select") }), remove: async () => {} },
    },
  };
})();
