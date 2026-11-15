#!/usr/bin/env bash
# rclone-easy-migration launcher for Linux and macOS (bash 3.2+ compatible).
#
# Usage: ./start.sh [--no-browser] [--allow-sleep] [--help] [extra rclone args...]
#   Any other arguments are passed to "rclone rcd" (e.g. --config /path/rclone.conf, -vv).
# Env:   REM_FORCE_DOWNLOAD=1  ignore any installed rclone and offer to download one into ./bin
#        REM_BIN_DIR=<dir>     use <dir> instead of ./bin for the downloaded rclone (testing)

set -u

# --- script dir (portable, no readlink -f) -----------------------------------
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd) || exit 1
UI_DIR="$SCRIPT_DIR/ui"
BIN_DIR=${REM_BIN_DIR:-$SCRIPT_DIR/bin}
BASE_PORT=5572

fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# --- args ----------------------------------------------------------------------
NO_BROWSER=0
ALLOW_SLEEP=0
EXTRA=()
for a in "$@"; do
    case "$a" in
        --no-browser|-NoBrowser) NO_BROWSER=1 ;;
        --allow-sleep) ALLOW_SLEEP=1 ;;
        --help|-h)
            echo "Usage: start.sh [--no-browser] [extra rclone args...]"
            echo "  --no-browser   do not open the browser automatically"
            echo "  --allow-sleep  do not keep the computer awake while running"
            echo "  anything else is passed to \"rclone rcd\" (e.g. --config FILE, -vv)"
            exit 0 ;;
        *) EXTRA[${#EXTRA[@]}]=$a ;;
    esac
done

[ -d "$UI_DIR" ] || fail "UI folder not found: $UI_DIR
Make sure you extracted/cloned the whole project."

# --- helpers -------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

fetch() { # fetch URL DEST
    if have curl; then curl -fsSL -o "$2" "$1"
    elif have wget; then wget -q -O "$2" "$1"
    else return 127; fi
}

sha256_of() {
    if have sha256sum; then sha256sum "$1" | awk '{print $1}'
    elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
    else return 1; fi
}

install_rclone() {
    have curl || have wget || fail "Neither curl nor wget is installed, so rclone cannot be downloaded.
Install one of them (or install rclone yourself from https://rclone.org/downloads/)."
    have unzip || fail "unzip is not installed, so the rclone download cannot be extracted.
Install it (e.g. 'sudo apt install unzip' or 'sudo dnf install unzip') or install rclone yourself."

    case "$(uname -s)" in
        Darwin) os=osx ;;
        Linux)  os=linux ;;
        *) fail "Unsupported OS $(uname -s). Install rclone from https://rclone.org/downloads/" ;;
    esac
    m=$(uname -m)
    case "$m" in
        x86_64|amd64) arch=amd64 ;;
        aarch64|arm64) arch=arm64 ;;
        i386|i486|i586|i686) arch=386 ;;
        armv6*|armv7*|armv8l) arch=arm ;;
        *) fail "Unsupported CPU architecture '$m'. Install rclone from https://rclone.org/downloads/" ;;
    esac
    # x86_64 shell under Rosetta on Apple Silicon: prefer the native arm64 build
    if [ "$os" = osx ] && [ "$arch" = amd64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
        arch=arm64
    fi

    tmp=$(mktemp -d "${TMPDIR:-/tmp}/rem.XXXXXX") || fail "Cannot create a temp directory."
    echo "Looking up latest rclone version..."
    fetch "https://downloads.rclone.org/version.txt" "$tmp/version.txt" || { rm -rf "$tmp"; fail "Could not reach downloads.rclone.org."; }
    ver=$(sed 's/^rclone *//' "$tmp/version.txt" | tr -d ' \r\n')
    case "$ver" in v[0-9]*.[0-9]*.[0-9]*) ;; *) rm -rf "$tmp"; fail "Unexpected version string '$ver'." ;; esac
    name="rclone-$ver-$os-$arch.zip"
    echo "Downloading $name ..."
    fetch "https://downloads.rclone.org/$ver/$name" "$tmp/$name" || { rm -rf "$tmp"; fail "Download failed."; }

    fetch "https://downloads.rclone.org/$ver/SHA256SUMS" "$tmp/SHA256SUMS" || { rm -rf "$tmp"; fail "Could not download SHA256SUMS."; }
    expected=$(awk -v n="$name" '$2==n || $2=="*" n {print $1}' "$tmp/SHA256SUMS" | head -n 1)
    [ -n "$expected" ] || { rm -rf "$tmp"; fail "No checksum for $name in SHA256SUMS."; }
    actual=$(sha256_of "$tmp/$name") || { rm -rf "$tmp"; fail "Neither sha256sum nor shasum is available to verify the download."; }
    [ "$actual" = "$expected" ] || { rm -rf "$tmp"; fail "Checksum mismatch for $name (expected $expected, got $actual)."; }
    echo "Checksum OK."

    mkdir "$tmp/x" && unzip -q "$tmp/$name" -d "$tmp/x" || { rm -rf "$tmp"; fail "Could not extract the archive."; }
    bin=$(find "$tmp/x" -type f -name rclone | head -n 1)
    [ -n "$bin" ] || { rm -rf "$tmp"; fail "rclone binary not found in the archive."; }
    mkdir -p "$BIN_DIR" && cp "$bin" "$BIN_DIR/rclone" && chmod +x "$BIN_DIR/rclone" || { rm -rf "$tmp"; fail "Could not write to $BIN_DIR"; }
    if [ "$os" = osx ]; then xattr -d com.apple.quarantine "$BIN_DIR/rclone" >/dev/null 2>&1; fi
    rm -rf "$tmp"
    return 0
}

# --- locate rclone -------------------------------------------------------------
# Prefer the user's EXISTING rclone installation (and therefore their existing config/remotes).
# Order: $RCLONE_PATH -> PATH -> common install locations -> ./bin -> offer download.
# (A double-clicked start.command on macOS gets a minimal PATH without Homebrew, hence the list.)
RCLONE=""
if [ -z "${REM_FORCE_DOWNLOAD:-}" ]; then
    if [ -n "${RCLONE_PATH:-}" ] && [ -x "$RCLONE_PATH" ]; then
        RCLONE="$RCLONE_PATH"
    elif have rclone; then
        RCLONE=$(command -v rclone)
    else
        for c in /opt/homebrew/bin/rclone /usr/local/bin/rclone /usr/bin/rclone /snap/bin/rclone \
                 /opt/local/bin/rclone "$HOME/.local/bin/rclone" "$HOME/bin/rclone"; do
            if [ -x "$c" ]; then RCLONE="$c"; break; fi
        done
    fi
fi
if [ -z "$RCLONE" ] && [ -x "$BIN_DIR/rclone" ]; then
    RCLONE="$BIN_DIR/rclone"
fi

if [ -z "$RCLONE" ]; then
    echo "rclone was not found (looked on your PATH, common install locations and ./bin)."
    echo "If you already have rclone somewhere else, set RCLONE_PATH to its full path and run this again."
    printf 'Download rclone now into %s ? [Y/n] ' "$BIN_DIR"
    ans=""; read -r ans || ans=""
    case "$ans" in n|N|no|NO|No) fail "rclone is required. Install it from https://rclone.org/downloads/ and run this again." ;; esac
    install_rclone
    RCLONE="$BIN_DIR/rclone"
fi

echo
"$RCLONE" version | head -n 1
[ -x "$RCLONE" ] || fail "Could not run $RCLONE"
echo "Using rclone: $RCLONE"
case " ${EXTRA[*]-} " in
    *" --config"*) ;;
    *) cfg=$("$RCLONE" config file 2>/dev/null | tail -n 1)
       [ -n "$cfg" ] && echo "Using config: $cfg  (your existing remotes)" ;;
esac

# --- port probe ----------------------------------------------------------------
port_in_use() { # success if something listens on 127.0.0.1:$1
    if have nc; then nc -z 127.0.0.1 "$1" >/dev/null 2>&1; return $?; fi
    if (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; then return 0; fi
    return 1
}

# --- credentials ---------------------------------------------------------------
RC_USER="rem-$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 8)"
RC_PASS=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 28)
[ "${#RC_PASS}" -ge 24 ] || fail "Could not generate random credentials."
# passed via environment so they do not appear in the process list
export RCLONE_RC_USER="$RC_USER" RCLONE_RC_PASS="$RC_PASS"

# --- start rclone ----------------------------------------------------------------
PID=""
INH_PID=""
cleanup() {
    trap - INT TERM EXIT
    if [ -n "$INH_PID" ]; then kill "$INH_PID" 2>/dev/null; fi
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null
        sleep 1
        kill -9 "$PID" 2>/dev/null
        wait "$PID" 2>/dev/null
    fi
}
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap cleanup EXIT

LOG_FILE=""
case " ${EXTRA[*]-} " in
    *" --log-file"*) ;;
    *)
        if mkdir -p "$SCRIPT_DIR/logs" 2>/dev/null; then
            LOG_FILE="$SCRIPT_DIR/logs/rclone-$(date +%Y%m%d-%H%M%S).log"
        fi ;;
esac
LOG_ARGS=()
if [ -n "$LOG_FILE" ]; then LOG_ARGS=(--log-file "$LOG_FILE"); fi

PORT=""
p=$BASE_PORT
while [ "$p" -lt $((BASE_PORT + 20)) ]; do
    if ! port_in_use "$p"; then
        "$RCLONE" rcd --rc-addr "127.0.0.1:$p" --rc-files "$UI_DIR" \
            --rc-job-expire-duration 24h --log-level NOTICE ${LOG_ARGS[@]+"${LOG_ARGS[@]}"} ${EXTRA[@]+"${EXTRA[@]}"} &
        PID=$!
        # wait up to 10s for the server; detect early exit (e.g. address in use)
        i=0; ready=0
        while [ "$i" -lt 50 ]; do
            kill -0 "$PID" 2>/dev/null || break
            if have curl; then
                if curl -fsS -m 2 -o /dev/null -X POST -u "$RC_USER:$RC_PASS" "http://127.0.0.1:$p/core/version" 2>/dev/null; then ready=1; break; fi
            elif have wget; then
                if wget -q -O /dev/null --user="$RC_USER" --password="$RC_PASS" --auth-no-challenge --post-data='' "http://127.0.0.1:$p/core/version" 2>/dev/null; then ready=1; break; fi
            else
                if port_in_use "$p"; then ready=1; break; fi
            fi
            sleep 0.2
            i=$((i + 1))
        done
        if [ "$ready" = 1 ]; then PORT=$p; break; fi
        if kill -0 "$PID" 2>/dev/null; then fail "rclone did not start answering within 10 seconds."; fi
        rc=0; wait "$PID" 2>/dev/null || rc=$?
        PID=""
        # exited early: most likely the port was taken meanwhile; try the next one
        echo "rclone exited (code $rc) on port $p; trying the next port..." >&2
    fi
    p=$((p + 1))
done
[ -n "$PORT" ] || fail "Could not start rclone on any port between $BASE_PORT and $((BASE_PORT + 19))."

# --- keep the computer awake (idle sleep only; the display may still turn off) ---
SLEEP_MSG="off"
if [ "$ALLOW_SLEEP" = 0 ]; then
    if [ "$(uname -s)" = Darwin ]; then
        if have caffeinate; then
            caffeinate -i -w "$PID" >/dev/null 2>&1 &
            INH_PID=$!; SLEEP_MSG="on (caffeinate)"
        fi
    elif have systemd-inhibit; then
        # holds the inhibitor lock until rclone exits (tail --pid is GNU, fine on Linux)
        systemd-inhibit --what=idle:sleep --who=rclone-easy-migration --why="rclone migration running"             tail --pid="$PID" -f /dev/null >/dev/null 2>&1 &
        INH_PID=$!
        sleep 0.5
        if kill -0 "$INH_PID" 2>/dev/null; then SLEEP_MSG="on (systemd-inhibit)"; else INH_PID=""; fi
    fi
    if [ "$SLEEP_MSG" = off ]; then echo "Note: no sleep-prevention tool found (caffeinate/systemd-inhibit); disable automatic suspend in your system settings for long migrations."; fi
fi

URL="http://127.0.0.1:$PORT/"
echo
echo "=============================================================="
echo "  rclone-easy-migration is running"
echo "=============================================================="
echo "  URL:       $URL   (local to this computer only)"
echo "  Username:  $RC_USER"
echo "  Password:  $RC_PASS"
if [ -n "$LOG_FILE" ]; then echo "  Log file:  $LOG_FILE"; fi
case "$SLEEP_MSG" in off) echo "  Sleep prevention: off" ;; *) echo "  Sleep prevention: $SLEEP_MSG (screen may still turn off; closing a laptop lid may still suspend)" ;; esac
echo
echo "  If your browser asks for a username/password, use the above."
echo "  Press Ctrl+C to stop. Closing this window also stops the app"
echo "  (and any running transfers). The Quit button in the UI works too."
echo

if [ "$NO_BROWSER" = 0 ]; then
    FULL="http://$RC_USER:$RC_PASS@127.0.0.1:$PORT/"
    if [ "$(uname -s)" = Darwin ] && have open; then
        open "$FULL" >/dev/null 2>&1
    elif have xdg-open; then
        xdg-open "$FULL" >/dev/null 2>&1 &
    else
        echo "Could not open a browser automatically. Open $URL yourself and log in with the credentials above."
    fi
fi

wait "$PID"
PID=""
echo "rclone has stopped. Goodbye."
