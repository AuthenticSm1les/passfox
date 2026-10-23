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


def ask(env, message):
    data = json.dumps(message).encode()
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

        def insert(path, body):
            subprocess.run(["pass", "insert", "-m", path], input=body.encode(), env=env, check=True, capture_output=True)

        insert("www/github.com/alice", "s3cret\nurl: https://github.com\n")
        insert("www/example.co.uk/bob@example.co.uk", "hunter2\n")
        insert("misc/notes", "nothing\nlogin: carol\n")
        insert("www/github.com/work", "pw\nusername: alice@work\n")
        insert("otp/github.com", "otpauth://totp/x?secret=AAAA\n")

        listing = ask(env, {"action": "list"})["entries"]
        by_path = {e["path"]: e for e in listing}
        alice = dict(by_path["www/github.com/alice"])
        assert isinstance(alice.pop("modified"), int), alice
        assert alice == {"path": "www/github.com/alice", "domain": "github.com", "username": "alice"}, alice
        assert by_path["www/example.co.uk/bob@example.co.uk"]["domain"] == "example.co.uk"
        assert by_path["misc/notes"]["domain"] is None
        assert by_path["otp/github.com"]["domain"] is None

        got = ask(env, {"action": "get", "path": "www/github.com/alice"})
        assert got == {"password": "s3cret", "username": "alice", "url": "https://github.com"}, got
        got = ask(env, {"action": "get", "path": "www/github.com/work"})
        assert got["username"] == "alice@work", got

        for bad in ["../etc/passwd", "/etc/passwd", "-x", "www/../../x", "www//x", "nope"]:
            assert "error" in ask(env, {"action": "get", "path": bad}), bad

        # Save a new login, then update it and check extra lines survive.
        assert ask(env, {"action": "insert", "path": "www/new.test/dave", "username": "dave", "password": "one"})["ok"]
        assert ask(env, {"action": "get", "path": "www/new.test/dave"})["password"] == "one"
        assert ask(env, {"action": "insert", "path": "www/github.com/alice", "username": "alice", "password": "two"})["ok"]
        got = ask(env, {"action": "get", "path": "www/github.com/alice"})
        assert got == {"password": "two", "username": "alice", "url": "https://github.com"}, got
        assert "error" in ask(env, {"action": "insert", "path": "www/x/y", "username": "a", "password": "a\nb"})

        # Generate with pass's own settings, then adopt into a new login...
        gen = ask(env, {"action": "generate", "path": "www/new.test/passfox-generated-1"})
        assert len(gen["password"]) == 21 and gen["entry"]["username"] == "", gen
        assert "error" in ask(env, {"action": "generate", "path": "www/new.test/passfox-generated-1"})
        assert "error" in ask(env, {"action": "generate", "path": "www/new.test/erin"})
        assert ask(env, {"action": "adopt", "from": "www/new.test/passfox-generated-1", "to": "www/new.test/erin", "username": "erin"})["ok"]
        assert ask(env, {"action": "get", "path": "www/new.test/erin"})["password"] == gen["password"]
        assert "error" in ask(env, {"action": "get", "path": "www/new.test/passfox-generated-1"})
        # ...and into an existing one, keeping its other lines.
        gen = ask(env, {"action": "generate", "path": "www/github.com/passfox-generated-2"})
        assert ask(env, {"action": "adopt", "from": "www/github.com/passfox-generated-2", "to": "www/github.com/alice", "username": "alice"})["ok"]
        got = ask(env, {"action": "get", "path": "www/github.com/alice"})
        assert got == {"password": gen["password"], "username": "alice", "url": "https://github.com"}, got
        assert "error" in ask(env, {"action": "get", "path": "www/github.com/passfox-generated-2"})
        # Only generated entries can be adopted (i.e. renamed or removed).
        assert "error" in ask(env, {"action": "adopt", "from": "www/github.com/work", "to": "www/github.com/x", "username": "x"})
        assert "error" in ask(env, {"action": "bogus"})
        # Copying goes through pass -c (no display here, so pass's own error).
        assert "display" in ask(env, {"action": "clip", "path": "www/github.com/alice"}).get("error", "").lower()

        subprocess.run(["gpgconf", "--kill", "gpg-agent"], env=env, capture_output=True)
    print("host tests passed")


if __name__ == "__main__":
    main()
