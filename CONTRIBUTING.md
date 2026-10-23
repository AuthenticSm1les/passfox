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
| `host/passfox_host.py` | Native messaging host that runs `pass` |
| `install.sh` | Installs the host for the current user |
| `test/` | Host tests, harness pages and mock login pages |
| `tools/` | Vendoring Firefox's styles and icons, and syncing the AMO listing |
| `amo/` | The addons.mozilla.org listing: text, icon and screenshots |

## Development

```sh
python3 -I test/host_test.py              # host tests with a throwaway GPG key and store
python3 -I test/serve.py 8765 .           # then open /test/harness.html or /test/popup-harness.html(#pending)
npx addons-linter --warnings-as-errors extension
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
Saving a login there writes `www/localhost/<user>` to your store; remove it
afterwards with `pass rm -r www/localhost` (and `www/auth.localhost`).

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
git tag v0.4.0 && git push origin v0.4.0
```

The AUR package ([`passfox-host`](https://aur.archlinux.org/packages/passfox-host))
builds from the tag, so bump its `pkgver` there too.
