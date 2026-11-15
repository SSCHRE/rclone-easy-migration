#!/bin/sh
# macOS double-click launcher: runs start.sh from this folder.
cd "$(dirname "$0")" || exit 1
exec ./start.sh "$@"
