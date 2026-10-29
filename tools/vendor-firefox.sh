#!/bin/sh
# Re-vendor what passfox copies from Firefox, straight from the installed
# Firefox (default /usr/lib/firefox): the design tokens and icons for the
# autocomplete popup and doorhanger, and about:logins for the passwords page.
# Needs 7z.
set -eu

ff=${1:-/usr/lib/firefox}
here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/extension/vendor/firefox"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# omni.ja is an optimized zip that 7z reads with a warning, hence || true.
7z x -y -o"$tmp/gre" "$ff/omni.ja" >/dev/null 2>&1 || true
7z x -y -o"$tmp/browser" "$ff/browser/omni.ja" >/dev/null 2>&1 || true
g="$tmp/gre/chrome/toolkit/skin/classic/global"

mkdir -p "$out/icons"
# rem in a web page means the page's root font size, not the browser UI font,
# so route every rem through --passfox-rem (set from the UI font at runtime).
for f in tokens-shared tokens-platform; do
  sed -E -e '/^@import/d' \
    -e 's/(-?[0-9]*\.?[0-9]+)rem\b/calc(\1 * var(--passfox-rem, 1rem))/g' \
    "$g/design-system/$f.css" > "$out/$f.css"
done
python3 -I "$here/tools/unwrap-nova.py" "$out/tokens-shared.css" "$out/tokens-platform.css"
python3 -I "$here/tools/trim-tokens.py"
cp "$tmp/browser/chrome/browser/skin/classic/browser/login.svg" "$out/icons/"
for i in edit arrow-down-12 defaultFavicon search-textbox edit-copy eye eye-slash; do
  cp "$g/icons/$i.svg" "$out/icons/"
done
"$ff/firefox" --version > "$out/VERSION" 2>/dev/null || true

python3 "$here/tools/gen-icons.py"
python3 -I "$here/tools/vendor-aboutlogins.py" "$tmp"
