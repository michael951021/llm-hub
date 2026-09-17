#!/usr/bin/env bash
#
# Unpacks a modelhub-agent release archive and installs the binary to
# /usr/local/bin. This is a small convenience wrapper around the first two
# lines of docs/install.md — it does NOT enroll the node or install the
# system service, because both of those need input only the operator has
# (a pairing code, and root, respectively). See docs/install.md for the
# full path, including the NVIDIA `_cuda` archive and the manual
# verification checklist that closes out this slice.
#
# Usage:
#   scripts/install.sh /path/to/modelhub-agent_VERSION_OS_ARCH[_cuda].tar.gz
#
# Requires: tar, and either root or passwordless sudo to write to
# /usr/local/bin.
set -euo pipefail

if [ "$#" -ne 1 ]; then
	echo "usage: $0 /path/to/modelhub-agent_*.tar.gz" >&2
	exit 1
fi

archive="$1"
if [ ! -f "$archive" ]; then
	echo "error: no such file: $archive" >&2
	exit 1
fi

case "$archive" in
*.tar.gz | *.tgz) ;;
*)
	echo "error: expected a .tar.gz archive (the Windows release is a .zip and isn't handled by this script)" >&2
	exit 1
	;;
esac

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo "extracting $archive"
tar xzf "$archive" -C "$workdir"

binary="$workdir/modelhub-agent"
if [ ! -f "$binary" ]; then
	echo "error: archive did not contain a modelhub-agent binary at its top level" >&2
	exit 1
fi
chmod +x "$binary"

dest="/usr/local/bin/modelhub-agent"
echo "installing to $dest"
if [ -w "$(dirname "$dest")" ]; then
	mv "$binary" "$dest"
else
	sudo mv "$binary" "$dest"
fi

installed_version="$("$dest" --version)"
echo "installed: $installed_version"
echo
echo "Next steps (see docs/install.md):"
echo "  modelhub-agent enroll --code XXXX-XXXX --server https://<your-control-plane>:3001"
echo "  sudo modelhub-agent install"
