#!/usr/bin/env python3
"""Native messaging host connecting the passfox extension to pass(1)."""

import json
import os
import re
import struct
import sys

STORE = os.path.realpath(
    os.path.expanduser(os.environ.get("PASSWORD_STORE_DIR", "~/.password-store"))
)
HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z0-9-]+(:\d+)?$|^localhost(:\d+)?$", re.I)
USERNAME_KEYS = ("login", "username", "user", "email")
URL_KEYS = ("url", "website", "site")
# The folder holding website logins as <domain>/<username>, chosen in
# passfox's preferences and sent with every request ("" is the store root).
# Nothing outside it is listed, read or written.
BASE = ""
# Entries made by "Use a Securely Generated Password" before a username is
# known; they count as having no username until adopted.
GENERATED_PREFIX = "passfox-generated-"
# Where generated passwords wait when the name pattern has no {username}.
GENERATED_FOLDER = "passfox-generated"
# How login entries are named inside the folder, from passfox's preferences.
DEFAULT_LAYOUT = "{site}/{username}"
LAYOUT = None


# The layout value for "recognise any layout inside the folder".
AUTO = "auto"


def compile_layout(layout):
    """Turn a name pattern like "{url}/{username}" into a matcher with
    "site" and (optionally) "username" groups ({site} is the same as {url}).
    "auto" means any layout (see match_auto)."""
    if layout == AUTO:
        return AUTO
    layout = (layout or DEFAULT_LAYOUT).strip("/").replace("{url}", "{site}")
    pieces = re.split(r"(\{[a-z]+\})", layout)
    placeholders = [p for p in pieces if p.startswith("{")]
    if (
        placeholders.count("{site}") != 1
        or placeholders.count("{username}") > 1
        or set(placeholders) - {"{site}", "{username}"}
        or any(part in ("", ".", "..") or part.startswith("-") for part in layout.split("/"))
    ):
        raise ValueError("invalid name pattern: use {url} once and {username} at most once")
    # A trailing "/{username}" is optional, so an entry named just after the
    # site (with a login: line inside) still counts as that site's login.
    optional_username = layout.endswith("/{username}")
    if optional_username:
        pieces = re.split(r"(\{[a-z]+\})", layout[: -len("/{username}")])
    regex = "".join(
        "(?P<site>[^/]+)" if p == "{site}" else "(?P<username>.+)" if p == "{username}" else re.escape(p)
        for p in pieces
    )
    if optional_username:
        regex += "(?:/(?P<username>.+))?"
    return re.compile(f"^{regex}$")


def match_auto(rel):
    """Recognise a login in any common layout: the first part of its name
    that is a website (github.com/alice, github.com, folders/github.com/alice)
    or user@website (alice@github.com). Returns (site, username) or None."""
    parts = rel.split("/")
    for i, part in enumerate(parts):
        if HOSTNAME_RE.match(part):
            return part, "/".join(parts[i + 1:])
        user, at, host = part.rpartition("@")
        if at and user and HOSTNAME_RE.match(host):
            return host, "/".join([user, *parts[i + 1:]])
    return None


def is_generated(path):
    parts = path.split("/")
    return parts[-1].startswith(GENERATED_PREFIX) or GENERATED_FOLDER in parts[:-1]


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


def set_base(value):
    global BASE
    base = (value or "").strip("/")
    if base and any(p in ("", ".", "..") or p.startswith("-") for p in base.split("/")):
        raise ValueError("invalid login folder")
    BASE = base


def set_layout(value):
    global LAYOUT
    LAYOUT = compile_layout(value)


def check_path(path, must_exist=True):
    """Return path if it is a safe entry name inside the store, else raise."""
    if not isinstance(path, str) or not path or path.startswith(("/", "-")):
        raise ValueError("invalid entry path")
    parts = path.split("/")
    if any(p in ("", ".", "..") or p.startswith("-") for p in parts):
        raise ValueError("invalid entry path")
    prefix = BASE + "/" if BASE else ""
    if not path.startswith(prefix) or path == BASE:
        raise ValueError(f"not a login entry (outside {BASE}/)")
    full = os.path.realpath(os.path.join(STORE, path + ".gpg"))
    if not full.startswith(STORE + os.sep):
        raise ValueError("entry outside password store")
    if must_exist and not os.path.isfile(full):
        raise ValueError("no such entry")
    return path


def describe(path):
    """Map an entry path onto Firefox's site + username model."""
    rel = path[len(BASE) + 1:] if BASE else path
    layout = LAYOUT or compile_layout(None)
    if layout == AUTO:
        found = match_auto(rel)
    else:
        match = layout.match(rel)
        found = match and HOSTNAME_RE.match(match["site"]) and (match["site"], match.groupdict().get("username") or "")
    if found:
        domain, username = found[0].lower(), found[1]
    else:
        # Not named like a login (or the site isn't a hostname): listed on
        # the passwords page, never offered on a site.
        domain, username = None, rel.split("/")[-1]
    if is_generated(path):
        username = ""
    return {"path": path, "domain": domain, "username": username}


def cmd_list(_msg):
    return {"entries": list_dir(os.path.join(STORE, BASE) if BASE else STORE)}


def list_dir(top):
    entries = []
    for root, dirs, files in os.walk(top, followlinks=True):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(files):
            if name.endswith(".gpg"):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, STORE)[: -len(".gpg")]
                entry = describe(rel.replace(os.sep, "/"))
                # Stands in for Firefox's timePasswordChanged.
                entry["modified"] = int(os.path.getmtime(full) * 1000)
                entries.append(entry)
    return entries


def run_pass(args, stdin=None):
    # Imported here: listing, the most common request, never runs pass, and
    # these two modules are a fifth of the host's start-up time.
    import shutil
    import subprocess

    proc = subprocess.run(
        [shutil.which("pass") or "/usr/bin/pass", *args],
        input=stdin,
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, "PASSWORD_STORE_DIR": STORE},
        # pass -c leaves a process behind to restore the clipboard later;
        # keep it out of our process group so it outlives this host.
        start_new_session=True,
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
    login_line, url_line = field_lines(lines[1:])
    extra = [line for i, line in enumerate(lines[1:]) if i not in (login_line, url_line)]
    while extra and not extra[-1].strip():
        extra.pop()
    return {"password": password, "username": username, "url": url, "extra": extra}


def field_lines(lines):
    """Indexes of the first username line and the first url line (or None):
    the ones the passwords page edits as Username and Website address."""
    def first(keys):
        return next(
            (i for i, line in enumerate(lines) if ":" in line and line.partition(":")[0].strip().lower() in keys),
            None,
        )
    return first(USERNAME_KEYS), first(URL_KEYS)


def cmd_get(msg):
    path = check_path(msg.get("path"))
    entry = parse_entry(run_pass(["show", "--", path]))
    if not entry["username"]:
        entry["username"] = describe(path)["username"]
    return entry


def has_field(lines, keys):
    return any(line.partition(":")[0].strip().lower() in keys for line in lines if ":" in line)


def entry_body(password, old_lines, username, url):
    """The password, then the entry's other lines as they were, plus a
    login: and url: line when it doesn't have one (under any alias) yet."""
    lines = list(old_lines)
    while lines and not lines[-1].strip():
        lines.pop()
    if username and not has_field(lines, USERNAME_KEYS):
        lines.append(f"login: {username}")
    if url and not has_field(lines, URL_KEYS):
        lines.append(f"url: {url}")
    return "\n".join([password, *lines]) + "\n"


def cmd_insert(msg):
    path = check_path(msg.get("path"), must_exist=False)
    password = msg.get("password") or ""
    username = msg.get("username") or ""
    url = msg.get("url") or ""
    if not password or any("\n" in v or "\r" in v for v in (password, username, url)):
        raise ValueError("invalid password, username or url")
    if url and not re.match(r"^https?://[^\s/]+$", url):
        raise ValueError("url must be a site origin")
    old_lines = []
    if os.path.isfile(os.path.join(STORE, path + ".gpg")):
        old_lines = run_pass(["show", "--", path]).split("\n")[1:]
    run_pass(
        ["insert", "--multiline", "--force", "--", path],
        stdin=entry_body(password, old_lines, username, url),
    )
    return {"ok": True, "entry": describe(path)}


def cmd_generate(msg):
    path = check_path(msg.get("path"), must_exist=False)
    if not is_generated(path):
        raise ValueError(f"generated entries must be named {GENERATED_PREFIX}* or be in {GENERATED_FOLDER}/")
    if os.path.exists(os.path.join(STORE, path + ".gpg")):
        raise ValueError("entry already exists")
    # Length and character set come from the user's pass settings.
    run_pass(["generate", "--", path])
    entry = cmd_get({"path": path})
    if msg.get("url"):
        cmd_insert({"path": path, "password": entry["password"], "url": msg["url"]})
        entry["url"] = msg["url"]
    return {"entry": describe(path), **entry}


def cmd_clip(msg):
    """Copy the password with pass itself, which restores the previous
    clipboard after PASSWORD_STORE_CLIP_TIME."""
    run_pass(["show", "--clip", "--", check_path(msg.get("path"))])
    return {"ok": True}


def cmd_adopt(msg):
    """Give a generated entry its username: rename it, or, when that login
    already exists, move the new password into it (keeping its other lines)
    and drop the generated entry."""
    source = check_path(msg.get("from"))
    if not is_generated(source):
        raise ValueError("only generated entries can be adopted")
    target = check_path(msg.get("to"), must_exist=False)
    password = parse_entry(run_pass(["show", "--", source]))["password"]
    fields = {"password": password, "username": msg.get("username"), "url": msg.get("url")}
    if os.path.isfile(os.path.join(STORE, target + ".gpg")):
        cmd_insert({"path": target, **fields})
        run_pass(["rm", "--force", "--", source])
    else:
        run_pass(["mv", "--", source, target])
        cmd_insert({"path": target, **fields})
    return {"ok": True, "entry": describe(target)}


def set_field(lines, keys, key, value):
    """Point the first line under any of keys at value, or add key: value."""
    for i, line in enumerate(lines):
        name, sep, _ = line.partition(":")
        if sep and name.strip().lower() in keys:
            lines[i] = f"{name}: {value}"
            return
    lines.append(f"{key}: {value}")


def cmd_edit(msg):
    """Edit a login from the passwords page: new password, username and
    site. Other lines stay as they are; login:/url: (or their aliases) are
    updated in place. A new site or username renames the entry."""
    path = check_path(msg.get("path"))
    target = check_path(msg.get("to") or path, must_exist=False)
    password = msg.get("password") or ""
    username = msg.get("username") or ""
    url = msg.get("url") or ""
    if not password or any("\n" in v or "\r" in v for v in (password, username, url)):
        raise ValueError("invalid password, username or url")
    if url and not re.match(r"^https?://[^\s/]+$", url):
        raise ValueError("url must be a site origin")
    if target != path and os.path.exists(os.path.join(STORE, target + ".gpg")):
        raise ValueError("an entry for that site and username already exists")
    lines = run_pass(["show", "--", path]).split("\n")[1:]
    while lines and not lines[-1].strip():
        lines.pop()
    extra = msg.get("extra")
    if extra is not None:
        # The passwords page sent the entry's other lines (its extra fields):
        # keep the username and url lines and replace everything else.
        if not isinstance(extra, list) or any(not isinstance(l, str) or "\n" in l or "\r" in l for l in extra):
            raise ValueError("invalid extra fields")
        keep = [i for i in field_lines(lines) if i is not None]
        lines = [lines[i] for i in sorted(keep)] + extra
    if username:
        set_field(lines, USERNAME_KEYS, "login", username)
    if url:
        set_field(lines, URL_KEYS, "url", url)
    run_pass(["insert", "--multiline", "--force", "--", path], stdin="\n".join([password, *lines]) + "\n")
    if target != path:
        run_pass(["mv", "--", path, target])
    return {"ok": True, "entry": describe(target)}


def cmd_remove(msg):
    """Remove one login (the passwords page asks the user to confirm)."""
    path = check_path(msg.get("path"))
    run_pass(["rm", "--force", "--", path])
    return {"ok": True}


COMMANDS = {
    "list": cmd_list,
    "get": cmd_get,
    "insert": cmd_insert,
    "generate": cmd_generate,
    "clip": cmd_clip,
    "adopt": cmd_adopt,
    "edit": cmd_edit,
    "remove": cmd_remove,
}


def main():
    msg = read_message()
    if msg is None:
        return
    try:
        handler = COMMANDS.get(msg.get("action"))
        if handler is None:
            raise ValueError(f"unknown action {msg.get('action')!r}")
        set_base(msg.get("dir"))
        set_layout(msg.get("layout"))
        send_message(handler(msg))
    except Exception as exc:  # report every failure back to the extension
        send_message({"error": str(exc)})


if __name__ == "__main__":
    main()
