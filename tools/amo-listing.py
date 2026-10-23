#!/usr/bin/env python3
"""Sync the addons.mozilla.org listing from amo/: listing text and tags
(metadata.json), the icon (icon-128.png) and the screenshots
(screenshots/captions.json, in that order).

Usage: AMO_JWT_ISSUER=... AMO_JWT_SECRET=... tools/amo-listing.py [--dry-run]
"""

import base64
import hashlib
import hmac
import json
import os
import pathlib
import secrets
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = "https://addons.mozilla.org/api/v5/addons/addon/"
DRY_RUN = "--dry-run" in sys.argv


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
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"JWT {jwt_token()}")
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            text = resp.read().decode()
    except urllib.error.HTTPError as error:
        sys.exit(f"{method} {url} failed: {error.code} {error.read().decode()[:500]}")
    return json.loads(text) if text.strip() else {}


def main():
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text())
    addon = API + manifest["browser_specific_settings"]["gecko"]["id"] + "/"

    metadata = json.loads((ROOT / "amo" / "metadata.json").read_text())
    metadata.pop("version", None)  # per-version fields go with each submission
    request("PATCH", addon, json_body=metadata)

    request("PATCH", addon, files={"icon": ROOT / "amo" / "icon-128.png"})

    # Replace the screenshots so AMO matches amo/screenshots exactly.
    current = request("GET", addon).get("previews", [])
    for preview in current:
        request("DELETE", f"{addon}previews/{preview['id']}/")
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
    print("listing updated")


if __name__ == "__main__":
    main()
