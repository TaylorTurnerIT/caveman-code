#!/usr/bin/env bash
#
# Cave installer — extracts the full release tarball (binary + theme/, export-html/,
# photon_rs_bg.wasm, docs/, examples/) into a versioned dir and symlinks a shim onto PATH.
# The bare binary alone is not enough: cave resolves companions via dirname(process.execPath).
#
# Env knobs:
#   CAVE_VERSION   Tag to install (default: latest GitHub release)
#   CAVE_PREFIX    Install prefix (default: ~/.cave for non-root, /usr/local for root)
#   CAVE_BASE_URL  Override the download base (used by smoke tests)

set -euo pipefail

REPO="JuliusBrussee/caveman-cli"
KEEP_VERSIONS=2

err() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
    darwin|linux) ;;
    *) err "unsupported OS: $OS (use install.ps1 on Windows)" ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
    aarch64|arm64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *) err "unsupported architecture: $ARCH" ;;
esac

TRIPLE="${OS}-${ARCH}"

if [ -z "${CAVE_VERSION:-}" ]; then
    CAVE_VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep '"tag_name"' | head -1 | cut -d'"' -f4)"
    [ -n "$CAVE_VERSION" ] || err "could not resolve latest version from GitHub"
fi

if [ -z "${CAVE_PREFIX:-}" ]; then
    if [ "$(id -u)" = 0 ]; then
        CAVE_PREFIX="/usr/local"
    else
        CAVE_PREFIX="${HOME}/.cave"
    fi
fi

BASE_URL="${CAVE_BASE_URL:-https://github.com/${REPO}/releases/download/${CAVE_VERSION}}"
TARBALL="cave-${TRIPLE}.tar.gz"
URL="${BASE_URL}/${TARBALL}"

LIB_DIR="${CAVE_PREFIX}/lib/cave"
BIN_DIR="${CAVE_PREFIX}/bin"
VER_DIR="${LIB_DIR}/${CAVE_VERSION}"

info "Installing cave ${CAVE_VERSION} (${TRIPLE}) into ${CAVE_PREFIX}"

mkdir -p "$LIB_DIR" "$BIN_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

info "  downloading ${URL}"
curl -fsSL "$URL" -o "${TMP}/${TARBALL}" || err "download failed: ${URL}"

info "  extracting"
tar -xzf "${TMP}/${TARBALL}" -C "$TMP"
[ -d "${TMP}/cave" ] || err "tarball missing top-level cave/ dir"

rm -rf "$VER_DIR"
mv "${TMP}/cave" "$VER_DIR"
chmod +x "${VER_DIR}/cave"

ln -sfn "${VER_DIR}/cave" "${BIN_DIR}/cave"

# Prune older versions, keep most recent KEEP_VERSIONS (the one we just wrote stays via mtime)
if [ -d "$LIB_DIR" ]; then
    # shellcheck disable=SC2012
    ls -1t "$LIB_DIR" 2>/dev/null | tail -n +"$((KEEP_VERSIONS + 1))" | while read -r old; do
        info "  pruning old version: $old"
        rm -rf "${LIB_DIR:?}/${old}"
    done
fi

# PATH update for non-root user installs
if [ "$BIN_DIR" != "/usr/local/bin" ] && ! printf '%s' "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
    SENTINEL="# added by cave installer"
    LINE="export PATH=\"${BIN_DIR}:\$PATH\""
    UPDATED=""
    for rc in "${HOME}/.zshrc" "${HOME}/.bashrc" "${HOME}/.profile"; do
        [ -f "$rc" ] || continue
        if ! grep -Fqx "$SENTINEL" "$rc"; then
            printf '\n%s\n%s\n' "$SENTINEL" "$LINE" >> "$rc"
            UPDATED="${UPDATED} ${rc}"
        fi
    done
    if [ -n "$UPDATED" ]; then
        info ""
        info "Added ${BIN_DIR} to PATH in:${UPDATED}"
        info "Open a new shell or run: ${LINE}"
    else
        info ""
        info "Add ${BIN_DIR} to your PATH:"
        info "  ${LINE}"
    fi
fi

info ""
info "Installed: ${VER_DIR}"
"${BIN_DIR}/cave" --version
