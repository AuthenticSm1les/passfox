#!/bin/sh
# Install the passfox native messaging host for the current user.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
dest="${XDG_DATA_HOME:-$HOME/.local/share}/passfox"
manifests="$HOME/.mozilla/native-messaging-hosts"

install -Dm755 "$here/host/passfox_host.py" "$dest/passfox_host.py"
mkdir -p "$manifests"
sed "s|@HOST_PATH@|$dest/passfox_host.py|" "$here/host/io.github.smiley.passfox.json" \
  > "$manifests/io.github.smiley.passfox.json"

echo "Installed host to $dest/passfox_host.py"
echo "Installed manifest to $manifests/io.github.smiley.passfox.json"
