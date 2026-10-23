#!/usr/bin/env python3
"""Apply Firefox's Nova design unconditionally in vendored token CSS.

Firefox 158 ships with browser.nova.enabled=true and keeps the Nova values in
`@media -moz-pref("browser.nova.enabled") { ... }` blocks. Web pages can't
evaluate -moz-pref(), so they would silently fall back to the older Proton
values. This replaces each such block with its contents; the Nova cascade
layers are already ordered after the Proton ones, so they still win.

Usage: unwrap-nova.py FILE...   (edits in place)
"""

import re
import sys

OPENER = re.compile(r'@media\s+-moz-pref\("browser\.nova\.enabled"\)\s*\{')


def unwrap(css):
    out, pos = [], 0
    while (match := OPENER.search(css, pos)) :
        out.append(css[pos:match.start()])
        depth, i = 1, match.end()
        while depth:
            depth += {"{": 1, "}": -1}.get(css[i], 0)
            i += 1
        out.append(css[match.end():i - 1])
        pos = i
    out.append(css[pos:])
    return "".join(out)


for path in sys.argv[1:]:
    with open(path) as f:
        css = f.read()
    with open(path, "w") as f:
        f.write(unwrap(css))
