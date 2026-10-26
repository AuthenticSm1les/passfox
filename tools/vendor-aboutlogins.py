#!/usr/bin/env python3
"""Vendor Firefox's about:logins page into the extension.

Copies aboutLogins.html and everything it loads (modules, stylesheets,
icons, Fluent strings) out of an extracted Firefox omni.ja, rewrites the
chrome:// URLs to extension paths, applies the Nova design (see
unwrap-nova.py), and generates extension/logins/logins.html, which runs the
page with passfox's l10n.js and bridge.js in place of Firefox's internals.

Usage: vendor-aboutlogins.py EXTRACTED_FIREFOX
  where EXTRACTED_FIREFOX holds gre/ (omni.ja) and browser/ (browser/omni.ja).
"""

import importlib.util
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
OUT = EXT / "vendor" / "firefox" / "chrome"
L10N_OUT = EXT / "vendor" / "firefox" / "l10n"
WEB_ROOT = "/vendor/firefox/chrome"

src = pathlib.Path(sys.argv[1])
PACKAGES = {
    ("global", "content"): src / "gre/chrome/toolkit/content/global",
    ("global", "skin"): src / "gre/chrome/toolkit/skin/classic/global",
    ("browser", "content"): src / "browser/chrome/browser/content/browser",
    ("browser", "skin"): src / "browser/chrome/browser/skin/classic/browser",
}
# Mozilla branding passfox must not ship: use its own key icon instead.
REPLACEMENTS = {
    "chrome://branding/content/icon32.png": "/icons/login-dark.svg",
    "chrome://global/content/megalist/icons/cpm-fox-illustration.svg": "/icons/login-dark.svg",
}
FTL = [
    src / "browser/localization/en-US/browser/aboutLogins.ftl",
    src / "browser/localization/en-US/branding/brand.ftl",
    src / "gre/localization/en-US/toolkit/branding/brandings.ftl",
]

# Firefox's page-icon: favicons come from its history database, which an
# extension can't read; fetching every site's favicon would mean network
# requests, so logins get Firefox's default site icon.
DEFAULT_FAVICON = "chrome://global/skin/icons/defaultFavicon.svg"
PAGE_ICON = re.compile(r"`page-icon:\$\{[^}`]*\}`|\"page-icon:[^\"]*\"")
# Icons are drawn with context-fill, which only Firefox's own pages honour:
# give them the in-content text colour for light and dark instead.
ICON_FILL = "<style>svg{fill:#15141a}@media (prefers-color-scheme: dark){svg{fill:#fbfbfe}}</style>"
ICON_STROKE = "<style>svg{stroke:#15141a}@media (prefers-color-scheme: dark){svg{stroke:#fbfbfe}}</style>"

# passfox's changes to Firefox's code, applied after copying (each must match
# exactly once, so a Firefox update that changes the code fails loudly).
PATCHES = {
    "browser/content/aboutlogins/components/login-item.mjs": [
        # The website address can be edited on existing logins, not only on
        # new ones (pass entries are renamed to match).
        (
            "this._originInput.readOnly = !this.dataset.isNewLogin;",
            "this._originInput.readOnly = !(this.dataset.isNewLogin || shouldEdit);",
        ),
        (
            "    if (this.dataset.isNewLogin) {\n      this._originDisplayInput.replaceWith(this._originInput);\n      this._originInput.focus();",
            "    if (this.dataset.isNewLogin || this.dataset.editing) {\n      this._originDisplayInput.replaceWith(this._originInput);\n      this.dataset.isNewLogin && this._originInput.focus();",
        ),
        (
            "    if (this.dataset.isNewLogin) {\n      fields.push(this._originInput);",
            "    if (this.dataset.isNewLogin || this.dataset.editing) {\n      fields.push(this._originInput);",
        ),
    ],
}

CHROME_URL = re.compile(r"chrome://(global|browser|branding)/(content|skin)/([A-Za-z0-9_./-]+)")
RELATIVE_IMPORT = re.compile(r"""(?:from|import)\s*\(?\s*["'](\.{1,2}/[^"']+)["']""")
TEXT_TYPES = {".css", ".mjs", ".js", ".html", ".svg"}

spec = importlib.util.spec_from_file_location("unwrap_nova", ROOT / "tools" / "unwrap-nova.py")
unwrap_nova = importlib.util.module_from_spec(spec)
sys.argv, argv = sys.argv[:1], sys.argv  # unwrap-nova.py edits files given on argv
spec.loader.exec_module(unwrap_nova)
sys.argv = argv


def local(package, kind, rest):
    return PACKAGES[(package, kind)] / rest


def rewrite(text):
    for url, replacement in REPLACEMENTS.items():
        text = text.replace(url, replacement)
    return CHROME_URL.sub(lambda m: f"{WEB_ROOT}/{m[1]}/{m[2]}/{m[3]}", text)


def vendor(start_files):
    seen = set()
    queue = list(start_files)
    while queue:
        package, kind, rest = queue.pop()
        if (package, kind, rest) in seen:
            continue
        seen.add((package, kind, rest))
        path = local(package, kind, rest)
        target = OUT / package / kind / rest
        target.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix not in TEXT_TYPES:
            shutil.copyfile(path, target)
            continue
        text = PAGE_ICON.sub(f'"{DEFAULT_FAVICON}"', path.read_text())
        for url in REPLACEMENTS:
            text = text.replace(url, "")
        for m in CHROME_URL.finditer(text):
            if m[1] != "branding":
                queue.append((m[1], m[2], m[3]))
        for m in RELATIVE_IMPORT.finditer(text):
            resolved = (pathlib.PurePosixPath(rest).parent / m[1]).as_posix()
            parts = []
            for part in resolved.split("/"):
                if part == "..":
                    parts.pop()
                elif part != ".":
                    parts.append(part)
            queue.append((package, kind, "/".join(parts)))
        text = rewrite(text)
        if path.suffix == ".css":
            text = unwrap_nova.unwrap(text)
        for old, new in PATCHES.get(f"{package}/{kind}/{rest}", []):
            if text.count(old) != 1:
                sys.exit(f"patch for {package}/{kind}/{rest} no longer applies:\n{old}")
            text = text.replace(old, new)
        if path.suffix == ".svg" and '<g class="nova">' in text:
            # Icons switch artwork with a -moz-pref() query too: keep Nova's.
            text = re.sub(r'<g class="proton">.*?</g>', "", text, flags=re.S)
            text = re.sub(r"<style>.*?</style>", "", text, flags=re.S)
        if path.suffix == ".svg" and "context-" in text:
            styles = (ICON_FILL if "context-fill" in text else "") + (ICON_STROKE if "context-stroke" in text else "")
            text = re.sub(r'\s(fill|stroke)(-opacity)?="context-[^"]*"', "", text)
            text = re.sub(r"(<svg[^>]*>)", lambda m: m[1] + styles, text, count=1)
        target.write_text(text)
    return seen


def build_page():
    html = (PACKAGES[("browser", "content")] / "aboutlogins/aboutLogins.html").read_text()
    # Extension pages have their own CSP; Firefox's would block everything.
    html = re.sub(r'\s*<meta http-equiv="Content-Security-Policy"[^>]*>', "", html)
    # Strings come from l10n.js, not Firefox's localization registry.
    html = re.sub(r'\s*<link rel="localization"[^>]*>', "", html)
    # Firefox's own internals stand in for these; passfox runs them first.
    first_module = html.index('<script type="module"')
    html = (
        html[:first_module]
        + '<script src="/logins/l10n.js"></script>\n    '
        + '<script src="/logins/bridge.js"></script>\n    '
        + '<link rel="stylesheet" href="/logins/logins.css">\n    '
        + html[first_module:]
    )
    # pass is the store: no importing, exporting or removing everything here.
    # (Settings stays: it opens passfox's preferences in about:addons.)
    for item in ("menuitem-import-file", "menuitem-export", "menuitem-remove-all-logins"):
        html = html.replace(f'class="menuitem-button {item} ghost-button"', f'class="menuitem-button {item} ghost-button" hidden')
    html = html.replace('<hr role="separator" class="menuitem-separator"></hr>', '<hr role="separator" class="menuitem-separator" hidden></hr>')
    out = EXT / "logins" / "logins.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(rewrite(html))
    return html


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    page = build_page()
    for url in REPLACEMENTS:
        page = page.replace(url, "")
    start = [(m[1], m[2], m[3]) for m in CHROME_URL.finditer(page) if m[1] != "branding"]
    files = vendor(start)
    L10N_OUT.mkdir(parents=True, exist_ok=True)
    for ftl in FTL:
        shutil.copyfile(ftl, L10N_OUT / ftl.name)
    print(f"vendored {len(files)} files and {len(FTL)} Fluent files for about:logins")


if __name__ == "__main__":
    main()
