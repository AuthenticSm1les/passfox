#!/usr/bin/env python3
"""Write the updates.json that Firefox polls (manifest update_url).

Usage: updates-json.py VERSION XPI_URL > updates.json
"""

import json
import pathlib
import sys

manifest = json.loads(
    (pathlib.Path(__file__).resolve().parent.parent / "extension" / "manifest.json").read_text()
)
version, link = sys.argv[1], sys.argv[2]
addon_id = manifest["browser_specific_settings"]["gecko"]["id"]
json.dump(
    {"addons": {addon_id: {"updates": [{"version": version, "update_link": link}]}}},
    sys.stdout,
    indent=2,
)
print()
