// End-to-end test of the passwords page's background handlers: loads
// extension/background.js with a fake `browser`, whose native messaging runs
// the real host against a throwaway GPG key and pass store.
//
// Run: node test/manager_test.mjs   (never touches ~/.password-store or ~/.gnupg)

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "passfox-manager-"));
const env = {
  ...process.env,
  GNUPGHOME: join(tmp, "gnupg"),
  PASSWORD_STORE_DIR: join(tmp, "store"),
};
const run = (cmd, args, input) => execFileSync(cmd, args, { env, input, stdio: ["pipe", "pipe", "pipe"] }).toString();

execFileSync("mkdir", ["-m", "700", env.GNUPGHOME]);
run("gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", "passfox-test@example.invalid", "default", "default", "never"]);
run("pass", ["init", "passfox-test@example.invalid"]);
run("pass", ["insert", "-m", "www/github.com/alice"], "pw-alice\nnote: keep\n");
run("pass", ["insert", "-m", "misc/token"], "secret\n");

// The native host, as Firefox would run it for sendNativeMessage.
let nativeCalls = 0;
function sendNativeMessage(_name, message) {
  nativeCalls++;
  const data = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  const out = spawnSync("python3", ["-I", join(root, "host/passfox_host.py")], {
    env,
    input: Buffer.concat([header, data]),
  }).stdout;
  return Promise.resolve(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString()));
}

const ORIGIN = "moz-extension://test/";
let listener;
const lifecycle = [];
// passfox's preferences: these tests start with the older pair of settings
// (folder www, default name), which must carry over as www/{url}/{username}.
let settings = { loginDir: "www" };
let session = {};
const storageListeners = [];
const menus = new Map();
let passwordSaving = { value: true, levelOfControl: "controllable_by_this_extension" };
const browser = {
  runtime: {
    getURL: path => ORIGIN + path,
    id: "passfox@test",
    sendNativeMessage,
    onMessage: { addListener: fn => (listener = fn) },
    onInstalled: { addListener: fn => lifecycle.push(fn) },
    onStartup: { addListener: fn => lifecycle.push(fn) },
    sendMessage: () => Promise.resolve(),
  },
  privacy: {
    services: {
      passwordSavingEnabled: {
        get: async () => ({ ...passwordSaving }),
        set: async ({ value }) => {
          passwordSaving = { value, levelOfControl: "controlled_by_this_extension" };
        },
      },
    },
  },
  storage: {
    session: {
      get: async key => (key == null ? { ...session } : Object.fromEntries([key].flat().filter(k => k in session).map(k => [k, session[k]]))),
      set: async items => void Object.assign(session, structuredClone(items)),
      remove: async keys => [keys].flat().forEach(k => delete session[k]),
    },
    local: {
      get: async keys => ({ ...(keys && !Array.isArray(keys) && typeof keys == "object" ? keys : {}), ...settings }),
      set: async items => {
        const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { oldValue: settings[k], newValue: v }]));
        settings = { ...settings, ...items };
        storageListeners.forEach(fn => fn(changes, "local"));
      },
    },
    onChanged: { addListener: fn => storageListeners.push(fn) },
  },
  tabs: { sendMessage: async () => {} },
  menus: {
    removeAll: async () => menus.clear(),
    create: item => menus.set(item.id, { ...item }),
    update: async (id, props) => Object.assign(menus.get(id), props),
    onClicked: { addListener() {} },
  },
  action: {},
};
// Loads the background as Firefox does when it starts or wakes from sleep.
function startBackground() {
  vm.runInNewContext(readFileSync(join(root, "extension/background.js"), "utf8"), {
    browser,
    URL,
    console: { ...console, info() {} },
    Promise,
    Date,
    Error,
    structuredClone,
    fetch: () => Promise.reject(new Error("no fetch in tests")),
    navigator: { clipboard: { writeText: async () => {} } },
  });
}
startBackground();

const page = { id: "passfox@test", url: ORIGIN + "logins/logins.html" };
const send = async (type, data = {}, sender = page) => listener({ type, ...data }, sender);

try {
  // Installing switches off Firefox's own "Ask to save passwords".
  await Promise.all(lifecycle.map(fn => fn()));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(passwordSaving.value, false);
  // ...and adds "Suggest Strong Password…" to password fields' context menu,
  // hidden while "Suggest strong passwords" is off.
  const menu = menus.get("passfox-suggest-password");
  assert.equal(JSON.stringify([menu.title, menu.contexts, menu.visible]), JSON.stringify(["&Suggest Strong Password…", ["password"], true]));
  await browser.storage.local.set({ suggestPasswords: false });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(menu.visible, false);
  await browser.storage.local.set({ suggestPasswords: true });

  // Listing: only www/ entries.
  let reply = await send("manager-list");
  assert.deepEqual(reply.result.map(e => e.path), ["www/github.com/alice"]);

  // Content scripts can't use the page's handlers.
  reply = await send("manager-get", { path: "www/github.com/alice" }, { id: "passfox@test", url: "https://evil.example/" });
  assert.equal(reply.error, "Not allowed");

  reply = await send("manager-get", { path: "www/github.com/alice" });
  assert.equal(reply.result.password, "pw-alice");

  // Create, then a duplicate (Firefox's "already exists" with the entry).
  reply = await send("manager-create", { origin: "https://site.test", username: "zoe", password: "pw-zoe" });
  assert.equal(reply.result.path, "www/site.test/zoe");
  assert.equal(run("pass", ["show", "www/site.test/zoe"]), "pw-zoe\nlogin: zoe\nurl: https://site.test\n");
  reply = await send("manager-create", { origin: "https://site.test", username: "zoe", password: "x" });
  assert.match(reply.error, /already exists/);
  assert.equal(reply.existingLoginGuid, "www/site.test/zoe");

  // Update in place keeps the other lines.
  reply = await send("manager-update", { path: "www/github.com/alice", origin: "https://github.com", username: "alice", password: "pw-alice-2" });
  assert.equal(reply.result.path, "www/github.com/alice");
  assert.equal(run("pass", ["show", "www/github.com/alice"]), "pw-alice-2\nnote: keep\nlogin: alice\nurl: https://github.com\n");

  // A new username renames the entry; renaming onto another login is refused.
  reply = await send("manager-update", { path: "www/github.com/alice", origin: "https://github.com", username: "alice2", password: "pw-alice-2" });
  assert.equal(reply.result.path, "www/github.com/alice2");
  assert.equal(run("pass", ["show", "www/github.com/alice2"]), "pw-alice-2\nnote: keep\nlogin: alice2\nurl: https://github.com\n");
  reply = await send("manager-update", { path: "www/github.com/alice2", origin: "https://site.test", username: "zoe", password: "x" });
  assert.match(reply.error, /already exists/);

  // Website addresses must be http(s).
  reply = await send("manager-create", { origin: "javascript:alert(1)", username: "x", password: "x" });
  assert.match(reply.error, /http/);

  // Remove one; never anything outside www/.
  reply = await send("manager-remove", { path: "www/site.test/zoe" });
  assert.ok(reply.result.ok);
  reply = await send("manager-list");
  assert.deepEqual(reply.result.map(e => e.path), ["www/github.com/alice2"]);
  reply = await send("manager-remove", { path: "misc/token" });
  assert.ok(reply.error);
  assert.equal(run("pass", ["show", "misc/token"]), "secret\n");

  // The default login folder is the store root: every entry is a login,
  // and new ones are saved at the top level.
  await browser.storage.local.set({ loginPattern: "{url}/{username}" });
  reply = await send("manager-list");
  assert.deepEqual(reply.result.map(e => e.path).sort(), ["misc/token", "www/github.com/alice2"]);
  reply = await send("manager-create", { origin: "https://root.test", username: "ann", password: "pw" });
  assert.equal(reply.result.path, "root.test/ann");
  assert.equal(run("pass", ["show", "root.test/ann"]), "pw\nlogin: ann\nurl: https://root.test\n");

  // Name patterns from the preferences: username@site...
  await browser.storage.local.set({ loginPattern: "named/{username}@{url}" });
  reply = await send("manager-create", { origin: "https://example.org", username: "bob", password: "pw-bob" });
  assert.equal(reply.result.path, "named/bob@example.org");
  reply = await send("manager-list");
  assert.deepEqual(reply.result.map(e => [e.path, e.domain, e.username]), [["named/bob@example.org", "example.org", "bob"]]);

  // ...and one entry per site, where a username change doesn't rename it.
  await browser.storage.local.set({ loginPattern: "sites/{url}" });
  reply = await send("manager-create", { origin: "https://example.net", username: "dan", password: "pw-dan" });
  assert.equal(reply.result.path, "sites/example.net");
  reply = await send("manager-create", { origin: "https://example.net", username: "eve", password: "x" });
  assert.match(reply.error, /already exists/);
  reply = await send("manager-update", { path: "sites/example.net", origin: "https://example.net", username: "dana", password: "pw-dan-2" });
  assert.equal(reply.result.path, "sites/example.net");
  assert.equal(run("pass", ["show", "sites/example.net"]), "pw-dan-2\nlogin: dana\nurl: https://example.net\n");

  // Extra fields: created with a login, then replaced on edit, with the
  // username and url lines kept.
  reply = await send("manager-create", { origin: "https://fields.test", username: "kai", password: "pw", extra: ["pin: 1234", "note"] });
  const fieldsPath = reply.result.path;
  assert.equal(run("pass", ["show", fieldsPath]), "pw\nlogin: kai\nurl: https://fields.test\npin: 1234\nnote\n");
  reply = await send("manager-get", { path: fieldsPath });
  assert.equal(JSON.stringify(reply.result.extra), JSON.stringify(["pin: 1234", "note"]));
  reply = await send("manager-update", { path: fieldsPath, origin: "https://fields.test", username: "kai", password: "pw", extra: ["pin: 9999"] });
  assert.equal(run("pass", ["show", fieldsPath]), "pw\nlogin: kai\nurl: https://fields.test\npin: 9999\n");

  // Just a folder: any layout inside it is recognised, nothing outside.
  run("pass", ["insert", "-m", "www/carol@example.org"], "pw-carol\n");
  await browser.storage.local.set({ loginPattern: "www" });
  reply = await send("manager-list");
  assert.deepEqual(
    reply.result.map(e => [e.path, e.domain, e.username]).sort(),
    [["www/carol@example.org", "example.org", "carol"], ["www/github.com/alice2", "github.com", "alice2"]]
  );
  reply = await send("manager-create", { origin: "https://auto.test", username: "ivy", password: "pw" });
  assert.equal(reply.result.path, "www/auto.test/ivy");

  // The login list survives the background sleeping: a fresh start reads it
  // from session storage without starting the host.
  const tab = { id: 7, windowId: 1, url: "https://auto.test/login" };
  const site = { id: "passfox@test", url: tab.url, tab };
  await send("logins", {}, site);
  startBackground();
  nativeCalls = 0;
  reply = await send("logins", {}, site);
  assert.equal(JSON.stringify(reply.result.map(l => l.username)), JSON.stringify(["ivy"]));
  assert.equal(nativeCalls, 0);

  // Without a toolbar panel, the save prompt falls back to the page and
  // flags the site (no password) for pages to check without waking the
  // background; answering the prompt clears the flag.
  await send("submitted", { username: "new", password: "pw-new", possibleUsernames: [] }, site);
  assert.equal(session["pending-7"].password, "pw-new");
  assert.equal(JSON.stringify(Object.keys(settings.inPageSaves)), JSON.stringify(["7"]));
  assert.equal(settings.inPageSaves[7].domain, "auto.test");
  assert.ok(!JSON.stringify(settings.inPageSaves).includes("pw-new"));
  await send("pendingDone", { action: "dismiss" }, site);
  assert.equal(JSON.stringify(settings.inPageSaves), "{}");
  assert.ok(!("pending-7" in session));

  // Prompts left unanswered are dropped the next time the background starts.
  await send("submitted", { username: "new", password: "pw-new", possibleUsernames: [] }, site);
  session["pending-7"].at -= 120_000;
  settings.inPageSaves[7].until -= 120_000;
  startBackground();
  await new Promise(r => setTimeout(r, 10));
  assert.ok(!("pending-7" in session));
  assert.equal(JSON.stringify(settings.inPageSaves), "{}");

  console.log("manager tests passed");
} finally {
  spawnSync("gpgconf", ["--kill", "gpg-agent"], { env });
  rmSync(tmp, { recursive: true, force: true });
}
