"use strict";

const askToSave = document.getElementById("ask-to-save");
const suggest = document.getElementById("suggest-passwords");
const exceptions = document.getElementById("exceptions");
const showExceptions = document.getElementById("show-exceptions");
const list = document.getElementById("exception-list");
const removeAll = document.getElementById("remove-all");

async function load() {
  const settings = await browser.storage.local.get({ askToSave: true, suggestPasswords: true, neverSave: [] });
  askToSave.checked = settings.askToSave;
  suggest.checked = settings.suggestPasswords;
  renderExceptions(settings.neverSave);
}

function renderExceptions(hosts) {
  list.replaceChildren(
    ...[...hosts].sort().map(host => {
      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.title = `Ask to save passwords for ${host} again`;
      remove.addEventListener("click", async () => {
        const { neverSave = [] } = await browser.storage.local.get("neverSave");
        await browser.storage.local.set({ neverSave: neverSave.filter(h => h != host) });
      });
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = host;
      item.append(name, remove);
      return item;
    })
  );
  document.getElementById("no-exceptions").hidden = hosts.length > 0;
  removeAll.disabled = hosts.length == 0;
}

askToSave.addEventListener("change", () => browser.storage.local.set({ askToSave: askToSave.checked }));
suggest.addEventListener("change", () => browser.storage.local.set({ suggestPasswords: suggest.checked }));
showExceptions.addEventListener("click", () => {
  exceptions.hidden = !exceptions.hidden;
  showExceptions.setAttribute("aria-expanded", String(!exceptions.hidden));
});
removeAll.addEventListener("click", () => browser.storage.local.set({ neverSave: [] }));
document.getElementById("manage").addEventListener("click", () =>
  browser.runtime.sendMessage({ type: "openManager" })
);

// Stay in step with "Never save" choices made while this page is open.
browser.storage.onChanged.addListener((changes, area) => {
  if (area == "local") {
    load();
  }
});

load();
