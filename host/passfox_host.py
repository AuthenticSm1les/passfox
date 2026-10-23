#!/usr/bin/env python3
"""Native messaging host connecting the passfox extension to pass(1)."""

import json
import os
import re
import shutil
import struct
import subprocess
import sys

STORE = os.path.realpath(
    os.path.expanduser(os.environ.get("PASSWORD_STORE_DIR", "~/.password-store"))
)
PASS = shutil.which("pass") or "/usr/bin/pass"
HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z0-9-]+(:\d+)?$|^localhost(:\d+)?$", re.I)
USERNAME_KEYS = ("login", "username", "user", "email")
URL_KEYS = ("url", "website", "site")
# Top-level folders that hold secrets other than site logins (TOTP seeds,
# FIDO2 keys); they are listed but never offered for a website.
NON_LOGIN_DIRS = set(filter(None, os.environ.get("PASSFOX_NON_LOGIN_DIRS", "otp:fido2").split(":")))


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("@I", raw)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def check_path(path, must_exist=True):
    """Return path if it is a safe entry name inside the store, else raise."""
    if not isinstance(path, str) or not path or path.startswith(("/", "-")):
        raise ValueError("invalid entry path")
    parts = path.split("/")
    if any(p in ("", ".", "..") or p.startswith("-") for p in parts):
        raise ValueError("invalid entry path")
    full = os.path.realpath(os.path.join(STORE, path + ".gpg"))
    if not full.startswith(STORE + os.sep):
        raise ValueError("entry outside password store")
    if must_exist and not os.path.isfile(full):
        raise ValueError("no such entry")
    return path


def describe(path):
    """Map an entry path onto Firefox's site + username model."""
    parts = path.split("/")
    domain, username = None, ""
    if parts[0] in NON_LOGIN_DIRS:
        return {"path": path, "domain": None, "username": ""}
    for i, part in enumerate(parts):
        if HOSTNAME_RE.match(part):
            domain = part.lower()
            rest = parts[i + 1:]
            username = "/".join(rest)
            break
    return {"path": path, "domain": domain, "username": username}


def cmd_list(_msg):
    entries = []
    for root, dirs, files in os.walk(STORE, followlinks=True):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(files):
            if name.endswith(".gpg"):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, STORE)[: -len(".gpg")]
                entry = describe(rel.replace(os.sep, "/"))
                # Stands in for Firefox's timePasswordChanged.
                entry["modified"] = int(os.path.getmtime(full) * 1000)
                entries.append(entry)
    return {"entries": entries}


def run_pass(args, stdin=None):
    proc = subprocess.run(
        [PASS, *args],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, "PASSWORD_STORE_DIR": STORE},
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"pass exited with {proc.returncode}")
    return proc.stdout


def parse_entry(text):
    lines = text.split("\n")
    password = lines[0] if lines else ""
    fields = {}
    for line in lines[1:]:
        key, sep, value = line.partition(":")
        if sep and key.strip():
            fields.setdefault(key.strip().lower(), value.strip())
    username = next((fields[k] for k in USERNAME_KEYS if fields.get(k)), None)
    url = next((fields[k] for k in URL_KEYS if fields.get(k)), None)
    return {"password": password, "username": username, "url": url}


def cmd_get(msg):
    path = check_path(msg.get("path"))
    entry = parse_entry(run_pass(["show", "--", path]))
    if not entry["username"]:
        entry["username"] = describe(path)["username"]
    return entry


def cmd_insert(msg):
    path = check_path(msg.get("path"), must_exist=False)
    password = msg.get("password") or ""
    username = msg.get("username") or ""
    if not password or "\n" in password or "\n" in username:
        raise ValueError("invalid password or username")
    full = os.path.join(STORE, path + ".gpg")
    if os.path.isfile(full):
        # Updating: keep every line after the password as it was.
        old = run_pass(["show", "--", path]).split("\n")
        body = "\n".join([password, *old[1:]])
    else:
        body = password + "\n"
        if username and username != describe(path)["username"]:
            body += f"login: {username}\n"
    run_pass(["insert", "--multiline", "--force", "--", path], stdin=body)
    return {"ok": True, "entry": describe(path)}


COMMANDS = {"list": cmd_list, "get": cmd_get, "insert": cmd_insert}


def main():
    msg = read_message()
    if msg is None:
        return
    try:
        handler = COMMANDS.get(msg.get("action"))
        if handler is None:
            raise ValueError(f"unknown action {msg.get('action')!r}")
        send_message(handler(msg))
    except Exception as exc:  # report every failure back to the extension
        send_message({"error": str(exc)})


if __name__ == "__main__":
    main()
