# passfox

Fill and save Firefox logins from [pass](https://www.passwordstore.org/), with
the look and behaviour of Firefox's built-in password manager.

- **Autocomplete popup** on login fields: a copy of `#PopupAutoComplete`
  (username, "From this website", a hover edit button, the "Manage Passwords"
  footer, ↑/↓/Enter/Esc), plus Firefox's yellow `:autofill` highlight.
- **Save / Update doorhanger** after you submit a new or changed password:
  "Save password for host?" with Username (with a ▾ list of usernames seen in
  the form and saved for the site) and Password (with a reveal eye) fields,
  Not now ▾ (Never save) and Save. Writes with `pass insert`. It opens as a
  real Firefox panel hanging from the passfox toolbar button; while the save
  is pending (60 s), clicking the button brings it back, like Firefox's key
  icon. Pin passfox to the toolbar, otherwise Firefox hangs the panel from
  the Extensions (puzzle) button. If Firefox won't open the panel (window not
  focused), the doorhanger is drawn inside the page instead.
- **Toolbar panel** listing this site's logins (click to fill, copy username or
  password; the clipboard is cleared after 45 s). "Manage Passwords" opens the
  same list for the whole store in a tab.

## Layout of your store

Entries are matched to sites by the first path part that looks like a hostname,
and the rest of the path is the username: `www/github.com/alice` → site
`github.com`, user `alice`. A `login:`, `username:`, `user:` or `email:` line in
the entry overrides the username. Subdomains match their base domain
(`gist.github.com` ↔ `github.com`), with exact-host matches listed first.
Top-level `otp/` and `fido2/` are never offered for sites (change this with
`PASSFOX_NON_LOGIN_DIRS`, colon-separated). New logins are saved as
`www/<host>/<username>`.

## Install

passfox has two parts: the Firefox add-on, and a small native host that runs
`pass` for it. You need `pass`, `gpg` and Python 3.

1. **Add-on:** install passfox from
   [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/passfox/).
   (Each [release](https://github.com/AuthenticSm1les/passfox/releases) also
   carries the Mozilla-signed `.xpi`.)
2. **Native host:** on Arch Linux, install
   [`passfox-host`](https://aur.archlinux.org/packages/passfox-host) from the
   AUR (it installs the host system-wide). Elsewhere, from a clone of this
   repository (or the `passfox-host-<version>.tar.gz` release file), run:

   ```sh
   ./install.sh
   ```

   This copies `host/passfox_host.py` to `~/.local/share/passfox/` and
   registers it in `~/.mozilla/native-messaging-hosts/`.
3. **Pin passfox to the toolbar** (Extensions menu → passfox → Pin to
   Toolbar), so the save prompt hangs from its button.

Decryption goes through your gpg-agent, so pinentry asks for your passphrase
just as it does for `pass show`.

To try a development copy instead: `about:debugging` → This Firefox → Load
Temporary Add-on → `extension/manifest.json` (removed when Firefox restarts).

## Releasing

Releases are submitted to addons.mozilla.org and published on GitHub by
[`.github/workflows/release.yml`](.github/workflows/release.yml) when a tag
matching the manifest version is pushed. The AMO listing text lives in
[`amo/metadata.json`](amo/metadata.json) and is sent with every submission.
If AMO holds a version for human review, the GitHub release goes out without
the `.xpi`, and AMO publishes it once approved.

One-time setup: create an API key at
https://addons.mozilla.org/developers/addon/api/key/ and store it as repository
secrets:

```sh
gh secret set AMO_JWT_ISSUER
gh secret set AMO_JWT_SECRET
```

Then, for each release, bump `version` in `extension/manifest.json`, commit,
and push a matching tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The release carries the native host as a tarball and, once signed, the
`.xpi` plus an `updates.json` that moves copies installed from the old
self-hosted 0.1.0 release over to AMO updates.

## How the UI copies Firefox

Firefox's chrome can't be extended, so passfox redraws the popup and doorhanger
inside a closed shadow root on the page. The styles come from Firefox's own
source:

- `extension/vendor/firefox/` holds Firefox's design tokens
  (`tokens-shared.css`, `tokens-platform.css`) and icons, pulled from the
  installed Firefox's `omni.ja` by `tools/vendor-firefox.sh`. The `rem` units
  are rewritten to `--passfox-rem` (the browser UI font size), because a
  page's own root font size would otherwise rescale them.
- `extension/shared/firefox.css` is adapted from `popup.css`,
  `autocomplete.css`, `autocomplete-row-item.css`, `popupnotification.css`,
  `moz-button.css` and `moz-input-text.css`.

Firefox 158 ships with its "Nova" design on (`browser.nova.enabled`), whose
values sit in `@media -moz-pref(...)` blocks that web content can't evaluate;
`tools/unwrap-nova.py` applies them unconditionally when vendoring, and the
icons use their Nova artwork.

The tokens use system colours (Field, AccentColor, Menu), like Firefox's chrome
on Linux does, so the result follows your GTK theme in light and dark. After a
Firefox update, run `tools/vendor-firefox.sh` again to pick up design changes.

Vendored and adapted Firefox files are under the MPL-2.0 and keep its headers.

## Development

```sh
python3 -I test/host_test.py              # host tests with a throwaway GPG key and store
python3 -I test/serve.py 8765 .           # then open /test/harness.html, /test/popup-harness.html(#pending)
```

The harness pages run the real content scripts and popup against a fake
extension API. `test/inject.js` does the same for any page served that way.

### Trying it in Firefox

```sh
python3 -I test/serve.py                  # mock login pages on http://localhost:8766/
```

With the add-on loaded, open http://localhost:8766/ for eight scenarios
(basic form, identifier-first, script-built form, change password, sign-up,
edge positions, hostile page styles, login inside an iframe). Each page lists
what to check. Form posts are thrown away and redirected to a welcome page.
The pages run on `localhost`, so saving a login there writes
`www/localhost/<user>` to your store; remove those entries afterwards with
`pass rm -r www/localhost` and `pass rm -r www/auth.localhost`
(`pass rm` takes one name at a time).
