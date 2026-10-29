#!/usr/bin/env python3
"""Sync the addons.mozilla.org listing from amo/: listing text and tags
(metadata.json), the icon (icon-128.png) and the screenshots
(screenshots/captions.json, in that order).

Usage: AMO_JWT_ISSUER=... AMO_JWT_SECRET=... tools/amo-listing.py [--dry-run] [PART...]

PART is text, icon or screenshots (default: all three).
"""

import base64
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = "https://addons.mozilla.org/api/v5/addons/addon/"
DRY_RUN = "--dry-run" in sys.argv
PARTS = [a for a in sys.argv[1:] if not a.startswith("--")] or ["text", "icon", "screenshots"]
# Waits AMO asks for beyond this mean an hourly limit: stop rather than sleep.
MAX_WAIT = 180


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def jwt_token():
    """AMO's API auth: an HS256 JWT signed with the API secret."""
    now = int(time.time())
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64url(json.dumps({
        "iss": os.environ["AMO_JWT_ISSUER"],
        "jti": secrets.token_hex(16),
        "iat": now,
        "exp": now + 60,
    }).encode())
    signing_input = f"{header}.{payload}".encode()
    signature = hmac.new(os.environ["AMO_JWT_SECRET"].encode(), signing_input, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64url(signature)}"


def multipart(fields, files):
    boundary = "passfox" + secrets.token_hex(12)
    body = b""
    for name, value in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    for name, path in files.items():
        body += (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{path.name}"\r\n'
            "Content-Type: image/png\r\n\r\n"
        ).encode() + path.read_bytes() + b"\r\n"
    return body + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


def request(method, url, json_body=None, fields=None, files=None):
    if json_body is not None:
        data, content_type = json.dumps(json_body).encode(), "application/json"
    elif files:
        data, content_type = multipart(fields or {}, files)
    else:
        data, content_type = None, None
    print(f"{method} {url}" + (f"  files={[p.name for p in files.values()]}" if files else ""))
    if DRY_RUN:
        return {}
    for attempt in range(10):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"JWT {jwt_token()}")
        if content_type:
            req.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = resp.read().decode()
            return json.loads(text) if text.strip() else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode()
            if error.code != 429:
                sys.exit(f"{method} {url} failed: {error.code} {detail[:500]}")
            # AMO throttles listing edits; wait as long as it asks.
            wait = int(error.headers.get("Retry-After") or (re.findall(r"(\d+) seconds", detail) or ["60"])[0])
            if wait > MAX_WAIT:
                sys.exit(f"AMO is rate-limiting listing edits; run this again in {wait // 60 + 1} minutes.")
            print(f"  throttled, waiting {wait + 2}s")
            time.sleep(wait + 2)
    sys.exit(f"{method} {url} still throttled after retries")


def main():
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text())
    addon = API + manifest["browser_specific_settings"]["gecko"]["id"] + "/"

    if "text" in PARTS:
        metadata = json.loads((ROOT / "amo" / "metadata.json").read_text())
        metadata.pop("version", None)  # per-version fields go with each submission
        request("PATCH", addon, json_body=metadata)

    if "icon" in PARTS:
        request("PATCH", addon, files={"icon": ROOT / "amo" / "icon-128.png"})

    if "screenshots" in PARTS:
        sync_screenshots(addon)
    print("listing updated:", ", ".join(PARTS))


def sync_screenshots(addon):
    """Replace the screenshots so AMO matches amo/screenshots exactly.

    The new ones go up before the old ones are removed, so being stopped by
    AMO's rate limit part way leaves extra screenshots, never missing ones."""
    current = request("GET", addon).get("previews", [])
    shots = json.loads((ROOT / "amo" / "screenshots" / "captions.json").read_text())
    for position, shot in enumerate(shots):
        created = request(
            "POST",
            f"{addon}previews/",
            fields={"position": position},
            files={"image": ROOT / "amo" / "screenshots" / shot["file"]},
        )
        if not DRY_RUN:
            request("PATCH", f"{addon}previews/{created['id']}/", json_body={"caption": {"en-US": shot["caption"]}})
    for preview in current:
        request("DELETE", f"{addon}previews/{preview['id']}/")


if __name__ == "__main__":
    main()
