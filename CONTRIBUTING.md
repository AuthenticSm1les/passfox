# Contributing to passfox

passfox is an interface between pass and Firefox, not a replacement for pass:
anything pass can do (generating, copying, moving, removing, git history) is
left to pass, and its settings are respected. New code is for what pass can't
do: Firefox's UI, finding login fields, matching sites, and the glue between
the two.

## Layout

| Path | What it is |
| --- | --- |
| `extension/` | The Firefox add-on (Manifest V3) |
| `extension/logins/` | The passwords page: Firefox's about:logins with passfox's bridge and Fluent shim |
| `host/passfox_host.py` | Native messaging host that runs `pass` |
| `install.sh` | Installs the host for the current user |
| `test/` | Host tests, harness pages and mock login pages |
| `tools/` | Vendoring Firefox's styles and icons, and syncing the AMO listing |
| `amo/` | The addons.mozilla.org listing: text, icon and screenshots |

## Development

```sh
python3 -I test/host_test.py              # host tests with a throwaway GPG key and store
python3 -I test/serve.py 8765 .           # then open /test/harness.html or /test/popup-harness.html(#pending)
python3 -I tools/lint.py                  # addons-linter, as AMO runs it
```

The host tests never touch your own store or keyring. The harness pages run
the real content scripts and toolbar panel against a fake extension API;
`test/inject.js` does the same for any page served this way.

To run a development copy in Firefox: install the host with `./install.sh`,
then `about:debugging` → This Firefox → Load Temporary Add-on →
`extension/manifest.json` (removed when Firefox restarts).

### Mock login pages

```sh
python3 -I test/serve.py                  # http://localhost:8766/
```

With the add-on loaded, the index lists eight scenarios: basic form,
identifier-first, script-built form, change password, sign-up, edge
positions, hostile page styles, and a login inside an iframe. Each page says
what to check. Form posts are thrown away and redirected to a welcome page.
Saving a login there writes `localhost/<user>` (inside your login folder) to
your store; remove it afterwards with `pass rm -r` on that folder (and
`auth.localhost`).

## How the UI copies Firefox

Firefox's own UI can't be extended, so passfox redraws the autocomplete popup
and the save doorhanger inside a closed shadow root on the page, and the save
doorhanger also as the toolbar panel. The styles come from Firefox's source:

- `extension/vendor/firefox/` holds Firefox's design tokens
  (`tokens-shared.css`, `tokens-platform.css`) and icons, pulled from the
  installed Firefox's `omni.ja` by `tools/vendor-firefox.sh`. `rem` units are
  rewritten to `--passfox-rem` (the browser UI font size), because a page's
  own root font size would otherwise rescale them.
- Firefox 158 ships with its Nova design on (`browser.nova.enabled`), whose
  values sit in `@media -moz-pref(...)` blocks that web content can't
  evaluate; `tools/unwrap-nova.py` applies them unconditionally, and the
  icons use their Nova artwork.
- `extension/shared/firefox.css` is adapted from Firefox's `popup.css`,
  `autocomplete.css`, `autocomplete-row-item.css`, `popupnotification.css`,
  `moz-button.css` and `moz-input-text.css`.

The tokens use system colours (Field, AccentColor, Menu), like Firefox's own
UI on Linux, so passfox follows the GTK theme in light and dark. After a
Firefox update, run `tools/vendor-firefox.sh` again. Vendored and adapted
Firefox files are under the MPL-2.0 and keep their headers.

### The passwords page

`extension/logins/logins.html` is Firefox's own `aboutLogins.html`, generated
by `tools/vendor-aboutlogins.py` along with everything it loads (its Lit
components, styles, icons and Fluent strings) under
`extension/vendor/firefox/chrome/`. The script rewrites `chrome://` URLs, applies
Nova, swaps Mozilla branding and Firefox-only `page-icon:` favicons for
passfox's, gives `context-fill` icons light and dark colours, and hides the
menu items for importing, exporting and removing everything. Its `PATCHES`
list holds passfox's few changes to Firefox's own code (such as letting the
website address be edited on existing logins); each must match exactly once,
so a Firefox update that changes that code stops the script.

Two small files stand in for Firefox's internals:

- `logins/bridge.js` replaces the `AboutLogins` actors. It answers the page's
  `AboutLogins*` events through the background and native host, and sends
  `AboutLoginsChromeToContent` messages back. Passwords aren't sent up front:
  the page asks for authentication (`promptForPrimaryPassword`) before
  revealing, copying or editing, and that's when the bridge decrypts one
  entry.
- `logins/l10n.js` is a compact Fluent implementation for `document.l10n`,
  reading Firefox's `aboutLogins.ftl` plus `logins/passfox.ftl`, which
  overrides the brand and a few strings.

Test it outside Firefox with the fake API in `test/logins-stub.js`:

```sh
python3 -I test/serve.py 8767 extension   # then open /logins/logins.html?stub=logins-stub.js
node test/manager_test.mjs                # the page's background handlers, end to end
```

## Screenshots

`amo/screenshots/stage.html` sets up each screenshot scene on a mock
`example.com` page with made-up logins and plays it on load, so headless
Firefox can capture it (see the comment at the top of the file). The images
are used by both the README and the AMO listing.

## Releasing

Releases go out when a tag matching the manifest version is pushed.
[`.github/workflows/release.yml`](.github/workflows/release.yml) lints the
add-on, publishes a GitHub release with the native host tarball, and submits
the version to addons.mozilla.org with [`amo/metadata.json`](amo/metadata.json).
It doesn't wait for AMO: listed versions are reviewed by people, and AMO signs
and publishes each one when it's approved.

The listing's text, tags, icon and screenshots live in [`amo/`](amo) and are
pushed to AMO by [`.github/workflows/amo-listing.yml`](.github/workflows/amo-listing.yml)
whenever they change on `main` (or when run by hand).

One-time setup: create an API key at
https://addons.mozilla.org/developers/addon/api/key/ and store it as
repository secrets:

```sh
gh secret set AMO_JWT_ISSUER
gh secret set AMO_JWT_SECRET
```

For each release, bump `version` in `extension/manifest.json`, commit, and
push a matching tag:

```sh
git tag v0.5.0 && git push origin v0.5.0
```

The AUR package ([`passfox-host`](https://aur.archlinux.org/packages/passfox-host))
builds from the tag, so bump its `pkgver` there too.
