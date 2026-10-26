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
function sendNativeMessage(_name, message) {
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
// passfox's preferences: these tests use a www/ login folder until the end.
let settings = { loginDir: "www" };
const storageListeners = [];
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
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    local: {
      get: async defaults => ({ ...(typeof defaults == "object" ? defaults : {}), ...settings }),
      set: async items => {
        const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { oldValue: settings[k], newValue: v }]));
        settings = { ...settings, ...items };
        storageListeners.forEach(fn => fn(changes, "local"));
      },
    },
    onChanged: { addListener: fn => storageListeners.push(fn) },
  },
  tabs: { onRemoved: { addListener() {} } },
  action: {},
};
vm.runInNewContext(readFileSync(join(root, "extension/background.js"), "utf8"), {
  browser,
  URL,
  console,
  Promise,
  Date,
  Error,
  fetch: () => Promise.reject(new Error("no fetch in tests")),
  navigator: { clipboard: { writeText: async () => {} } },
});

const page = { id: "passfox@test", url: ORIGIN + "logins/logins.html" };
const send = async (type, data = {}, sender = page) => listener({ type, ...data }, sender);

try {
  // Installing switches off Firefox's own "Ask to save passwords".
  await Promise.all(lifecycle.map(fn => fn()));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(passwordSaving.value, false);

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
  await browser.storage.local.set({ loginDir: "" });
  reply = await send("manager-list");
  assert.deepEqual(reply.result.map(e => e.path).sort(), ["misc/token", "www/github.com/alice2"]);
  reply = await send("manager-create", { origin: "https://root.test", username: "ann", password: "pw" });
  assert.equal(reply.result.path, "root.test/ann");
  assert.equal(run("pass", ["show", "root.test/ann"]), "pw\nlogin: ann\nurl: https://root.test\n");

  console.log("manager tests passed");
} finally {
  spawnSync("gpgconf", ["--kill", "gpg-agent"], { env });
  rmSync(tmp, { recursive: true, force: true });
}
