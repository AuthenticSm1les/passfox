#!/usr/bin/env python3
"""End-to-end test of host/passfox_host.py against a throwaway GPG key and store.

Run: python3 -I test/host_test.py   (never touches ~/.password-store or ~/.gnupg)
"""

import json
import os
import pathlib
import struct
import subprocess
import sys
import tempfile

HOST = pathlib.Path(__file__).resolve().parent.parent / "host" / "passfox_host.py"


def ask(env, message, dir="www", layout=None):
    """Send one request; dir and layout are the login folder and name pattern
    from passfox's preferences (these tests mostly use www/{site}/{username})."""
    data = json.dumps({"dir": dir, "layout": layout, **message}).encode()
    out = subprocess.run(
        [sys.executable, "-I", str(HOST)],
        input=struct.pack("@I", len(data)) + data,
        capture_output=True,
        env=env,
        check=True,
    ).stdout
    (length,) = struct.unpack("@I", out[:4])
    return json.loads(out[4 : 4 + length])


def main():
    with tempfile.TemporaryDirectory() as tmp:
        env = {
            **os.environ,
            "GNUPGHOME": f"{tmp}/gnupg",
            "PASSWORD_STORE_DIR": f"{tmp}/store",
            # passfox must defer to the user's pass settings.
            "PASSWORD_STORE_GENERATED_LENGTH": "21",
        }
        env.pop("DISPLAY", None)
        env.pop("WAYLAND_DISPLAY", None)
        os.makedirs(env["GNUPGHOME"], mode=0o700)
        subprocess.run(
            ["gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase", "",
             "--quick-gen-key", "passfox-test@example.invalid", "default", "default", "never"],
            env=env, check=True, capture_output=True,
        )
        subprocess.run(["pass", "init", "passfox-test@example.invalid"], env=env, check=True, capture_output=True)

        def raw(path):
            return subprocess.run(["pass", "show", path], env=env, check=True, capture_output=True, text=True).stdout

        def insert(path, body):
            subprocess.run(["pass", "insert", "-m", path], input=body.encode(), env=env, check=True, capture_output=True)

        insert("www/github.com/alice", "s3cret\nurl: https://github.com\n")
        insert("www/example.co.uk/bob@example.co.uk", "hunter2\n")
        insert("misc/notes", "nothing\nlogin: carol\n")
        insert("misc/git/github.com", "ghp_token\n")
        insert("www/Forum/dave", "pw3\n")
        insert("www/github.com/work", "pw\nusername: alice@work\n")
        insert("otp/github.com", "otpauth://totp/x?secret=AAAA\n")

        listing = ask(env, {"action": "list"})["entries"]
        by_path = {e["path"]: e for e in listing}
        alice = dict(by_path["www/github.com/alice"])
        assert isinstance(alice.pop("modified"), int), alice
        assert alice == {"path": "www/github.com/alice", "domain": "github.com", "username": "alice"}, alice
        assert by_path["www/example.co.uk/bob@example.co.uk"]["domain"] == "example.co.uk"
        # With the login folder set to www, tokens and TOTP seeds elsewhere
        # are neither listed nor readable through passfox.
        assert all(p.startswith("www/") for p in by_path), sorted(by_path)
        assert by_path["www/Forum/dave"] == {**by_path["www/Forum/dave"], "domain": None, "username": "dave"}
        for outside in ("misc/git/github.com", "otp/github.com", "misc/notes"):
            assert "error" in ask(env, {"action": "get", "path": outside}), outside
            assert "error" in ask(env, {"action": "clip", "path": outside}), outside
        assert "error" in ask(env, {"action": "insert", "path": "misc/x", "username": "a", "password": "b"})

        # The default login folder is the store root: every entry, with the
        # site taken from the first folder.
        root = {e["path"]: e for e in ask(env, {"action": "list"}, dir="")["entries"]}
        assert {"misc/notes", "otp/github.com", "www/github.com/alice"} <= set(root), sorted(root)
        assert root["www/github.com/alice"]["domain"] is None  # "www" isn't a site
        assert ask(env, {"action": "get", "path": "misc/notes"}, dir="")["password"] == "nothing"
        # A nested folder works too, and bad folders are refused.
        nested = ask(env, {"action": "list"}, dir="misc/git")["entries"]
        assert [(e["path"], e["domain"], e["username"]) for e in nested] == [("misc/git/github.com", "github.com", "")], nested
        for bad in ("../x", "www/../misc", "-x"):
            assert "error" in ask(env, {"action": "list"}, dir=bad), bad

        # Other name patterns: username@site, and one entry per site.
        insert("names/bob@example.org", "pw\n")
        insert("names/carol@work@example.org", "pw\n")
        insert("sites/example.net", "pw\nlogin: dan\n")
        named = {e["path"]: e for e in ask(env, {"action": "list"}, dir="names", layout="{username}@{site}")["entries"]}
        assert (named["names/bob@example.org"]["domain"], named["names/bob@example.org"]["username"]) == ("example.org", "bob")
        assert named["names/carol@work@example.org"]["username"] == "carol@work"
        single = ask(env, {"action": "list"}, dir="sites", layout="{site}")["entries"]
        assert [(e["domain"], e["username"]) for e in single] == [("example.net", "")], single
        assert ask(env, {"action": "get", "path": "sites/example.net"}, dir="sites", layout="{site}")["username"] == "dan"
        # With no {username}, generated passwords wait in passfox-generated/
        # and move to the site's entry once used.
        gen = ask(env, {"action": "generate", "path": "sites/passfox-generated/example.com/1", "url": "https://example.com"}, dir="sites", layout="{site}")
        assert gen["entry"]["domain"] is None and gen["entry"]["username"] == "", gen
        assert ask(env, {"action": "adopt", "from": "sites/passfox-generated/example.com/1", "to": "sites/example.com", "username": "erin", "url": "https://example.com"}, dir="sites", layout="{site}")["ok"]
        assert raw("sites/example.com") == gen["password"] + "\nurl: https://example.com\nlogin: erin\n", raw("sites/example.com")
        # "auto": any layout inside the folder, never outside it.
        insert("mixed/github.com/alice", "pw\n")
        insert("mixed/example.org", "pw\nlogin: fay\n")
        insert("mixed/gus@example.net", "pw\n")
        insert("mixed/personal/example.com/hal", "pw\n")
        insert("mixed/notes/recovery-codes", "pw\n")
        auto = {e["path"]: (e["domain"], e["username"]) for e in ask(env, {"action": "list"}, dir="mixed", layout="auto")["entries"]}
        assert auto == {
            "mixed/github.com/alice": ("github.com", "alice"),
            "mixed/example.org": ("example.org", ""),
            "mixed/gus@example.net": ("example.net", "gus"),
            "mixed/personal/example.com/hal": ("example.com", "hal"),
            "mixed/notes/recovery-codes": (None, "recovery-codes"),
        }, auto
        assert "error" in ask(env, {"action": "get", "path": "misc/notes"}, dir="mixed", layout="auto")

        # {url} is the same placeholder as {site}.
        url_named = ask(env, {"action": "list"}, dir="names", layout="{username}@{url}")["entries"]
        assert ("example.org", "bob") in [(e["domain"], e["username"]) for e in url_named], url_named
        for bad in ("{username}", "{site}/{site}", "{url}/{site}", "{site}/{user}", "../{site}", "{site}/{username}/{username}"):
            assert "error" in ask(env, {"action": "list"}, layout=bad), bad

        got = ask(env, {"action": "get", "path": "www/github.com/alice"})
        assert got == {"password": "s3cret", "username": "alice", "url": "https://github.com", "extra": []}, got
        got = ask(env, {"action": "get", "path": "www/github.com/work"})
        assert got["username"] == "alice@work", got

        for bad in ["../etc/passwd", "/etc/passwd", "-x", "www/../../x", "www//x", "nope"]:
            assert "error" in ask(env, {"action": "get", "path": bad}), bad

        # Save a new login, then update it and check extra lines survive.
        assert ask(env, {"action": "insert", "path": "www/new.test/dave", "username": "dave", "password": "one"})["ok"]
        assert ask(env, {"action": "get", "path": "www/new.test/dave"})["password"] == "one"
        assert ask(env, {"action": "insert", "path": "www/github.com/alice", "username": "alice", "password": "two"})["ok"]
        got = ask(env, {"action": "get", "path": "www/github.com/alice"})
        assert got == {"password": "two", "username": "alice", "url": "https://github.com", "extra": []}, got
        assert "error" in ask(env, {"action": "insert", "path": "www/x/y", "username": "a", "password": "a\nb"})

        # Generate with pass's own settings, then adopt into a new login...
        gen = ask(env, {"action": "generate", "path": "www/new.test/passfox-generated-1", "url": "https://new.test"})
        assert raw("www/new.test/passfox-generated-1") == gen["password"] + "\nurl: https://new.test\n"
        assert len(gen["password"]) == 21 and gen["entry"]["username"] == "", gen
        assert "error" in ask(env, {"action": "generate", "path": "www/new.test/passfox-generated-1"})
        assert "error" in ask(env, {"action": "generate", "path": "www/new.test/erin"})
        assert ask(env, {"action": "adopt", "from": "www/new.test/passfox-generated-1", "to": "www/new.test/erin", "username": "erin", "url": "https://new.test"})["ok"]
        assert raw("www/new.test/erin") == gen["password"] + "\nurl: https://new.test\nlogin: erin\n", raw("www/new.test/erin")
        assert ask(env, {"action": "get", "path": "www/new.test/erin"})["password"] == gen["password"]
        assert "error" in ask(env, {"action": "get", "path": "www/new.test/passfox-generated-1"})
        # ...and into an existing one, keeping its other lines.
        gen = ask(env, {"action": "generate", "path": "www/github.com/passfox-generated-2"})
        assert ask(env, {"action": "adopt", "from": "www/github.com/passfox-generated-2", "to": "www/github.com/alice", "username": "alice"})["ok"]
        got = ask(env, {"action": "get", "path": "www/github.com/alice"})
        assert got == {"password": gen["password"], "username": "alice", "url": "https://github.com", "extra": []}, got
        assert "error" in ask(env, {"action": "get", "path": "www/github.com/passfox-generated-2"})
        # Editing from the passwords page: values change in place, other
        # lines stay, and a new site or username renames the entry.
        insert("www/edit.test/kim", "old\nuser: kim\nnote: keep\nwebsite: https://edit.test\n")
        assert ask(env, {"action": "edit", "path": "www/edit.test/kim", "password": "new", "username": "kim", "url": "https://edit.test"})["ok"]
        assert raw("www/edit.test/kim") == "new\nuser: kim\nnote: keep\nwebsite: https://edit.test\n", raw("www/edit.test/kim")
        assert ask(env, {"action": "edit", "path": "www/edit.test/kim", "to": "www/other.test/lee", "password": "new2", "username": "lee", "url": "https://other.test"})["ok"]
        assert raw("www/other.test/lee") == "new2\nuser: lee\nnote: keep\nwebsite: https://other.test\n", raw("www/other.test/lee")
        assert "error" in ask(env, {"action": "get", "path": "www/edit.test/kim"})
        assert "error" in ask(env, {"action": "edit", "path": "www/other.test/lee", "to": "www/github.com/alice", "password": "x", "username": "alice"})
        assert "error" in ask(env, {"action": "edit", "path": "misc/notes", "password": "x"})
        # Extra fields: get returns the other lines; edit can replace them.
        insert("www/extra.test/joe", "pw\nlogin: joe\npin: 1234\notpauth://totp/x?secret=AB\nurl: https://extra.test\nnote\n")
        got = ask(env, {"action": "get", "path": "www/extra.test/joe"})
        assert got["extra"] == ["pin: 1234", "otpauth://totp/x?secret=AB", "note"], got
        assert ask(env, {"action": "edit", "path": "www/extra.test/joe", "password": "pw", "username": "joe", "url": "https://extra.test", "extra": ["pin: 9999", "otpauth://totp/x?secret=AB", "question: first pet"]})["ok"]
        assert raw("www/extra.test/joe") == "pw\nlogin: joe\nurl: https://extra.test\npin: 9999\notpauth://totp/x?secret=AB\nquestion: first pet\n", raw("www/extra.test/joe")
        assert "error" in ask(env, {"action": "edit", "path": "www/extra.test/joe", "password": "pw", "extra": ["a\nb"]})

        # Removing one login; nothing outside www/.
        assert ask(env, {"action": "remove", "path": "www/other.test/lee"})["ok"]
        assert "error" in ask(env, {"action": "get", "path": "www/other.test/lee"})
        assert "error" in ask(env, {"action": "remove", "path": "misc/notes"})
        assert raw("misc/notes").startswith("nothing")

        # Only generated entries can be adopted (i.e. renamed or removed).
        assert "error" in ask(env, {"action": "adopt", "from": "www/github.com/work", "to": "www/github.com/x", "username": "x"})
        assert "error" in ask(env, {"action": "bogus"})

        # Saving writes login: and url: lines; updating keeps the entry's
        # lines and only adds the ones it lacks (under any alias).
        assert ask(env, {"action": "insert", "path": "www/site.test/zoe", "username": "zoe", "password": "p1", "url": "https://site.test"})["ok"]
        assert raw("www/site.test/zoe") == "p1\nlogin: zoe\nurl: https://site.test\n", raw("www/site.test/zoe")
        insert("www/site.test/yan", "old\nemail: yan@site.test\nnote: keep me\n")
        assert ask(env, {"action": "insert", "path": "www/site.test/yan", "username": "yan", "password": "p2", "url": "https://site.test"})["ok"]
        assert raw("www/site.test/yan") == "p2\nemail: yan@site.test\nnote: keep me\nurl: https://site.test\n", raw("www/site.test/yan")
        assert "error" in ask(env, {"action": "insert", "path": "www/site.test/x", "username": "x", "password": "p", "url": "javascript:alert(1)"})
        # Copying goes through pass -c (no display here, so pass's own error).
        assert "display" in ask(env, {"action": "clip", "path": "www/github.com/alice"}).get("error", "").lower()

        # One-time codes come from pass otp, in the folder they're asked for.
        insert("otp/codes.test", "otpauth://totp/codes.test:kai?secret=JBSWY3DPEHPK3PXP&issuer=codes.test\n")
        totp = lambda: subprocess.run(["oathtool", "--totp", "-b", "JBSWY3DPEHPK3PXP"], capture_output=True, text=True).stdout.strip()
        before = totp()
        code = ask(env, {"action": "otp", "path": "otp/codes.test"}, dir="otp", layout="{url}")
        assert code.get("code") in (before, totp()), code  # either side of a 30s step
        assert [e["domain"] for e in ask(env, {"action": "list"}, dir="otp", layout="{url}")["entries"]] == ["codes.test", "github.com"]
        assert "outside" in ask(env, {"action": "otp", "path": "otp/codes.test"}).get("error", "")
        # A login without an otpauth:// line: pass-otp's own error.
        assert "error" in ask(env, {"action": "otp", "path": "www/github.com/alice"})

        subprocess.run(["gpgconf", "--kill", "gpg-agent"], env=env, capture_output=True)
    print("host tests passed")


if __name__ == "__main__":
    main()
