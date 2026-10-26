#!/usr/bin/env python3
"""Lint the extension with Mozilla's addons-linter, the way AMO does.

Fails on any error or warning except the known ones listed below, which come
from code vendored from Firefox and are reviewed there.
Usage: tools/lint.py
"""

import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ALLOWED = {
    # Lit builds its templates from its own static strings.
    ("UNSAFE_VAR_ASSIGNMENT", "vendor/firefox/chrome/global/content/vendor/lit.all.mjs"),
}

out = subprocess.run(
    ["npx", "--yes", "addons-linter@latest", "--output", "json", str(ROOT / "extension")],
    capture_output=True, text=True,
).stdout
report = json.loads(out)
problems = [
    m for kind in ("errors", "warnings") for m in report[kind]
    if (m["code"], m.get("file", "")) not in ALLOWED
]
for m in problems:
    print(f'{m["type"].upper()} {m["code"]} {m.get("file", "")}:{m.get("line", "")} {m["message"]}')
print(f"addons-linter: {len(problems)} problem(s), {report['summary']}")
sys.exit(1 if problems else 0)
