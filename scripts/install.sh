#!/bin/sh
# Install Bouncer from a GitHub release.
#
#   curl -fsSL https://github.com/griphaugland/bouncer/releases/latest/download/install.sh | sh
#   sh install.sh --version 0.3.0 --no-app
#
# Downloads the binary for this Mac, verifies its SHA-256 against the release's SHA256SUMS,
# then runs `bouncer install` (daemon, shims, Claude Code hooks, PATH). Re-run to upgrade.
# Private repo: works when the GitHub CLI (`gh`) is installed and logged in.
set -eu

REPO="griphaugland/bouncer"
VERSION="${BOUNCER_VERSION:-latest}"
WITH_APP=1

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --no-app) WITH_APP=0; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "Bouncer supports macOS only for now."
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

if [ "$VERSION" = "latest" ]; then
  TAG=""
else
  TAG="v${VERSION#v}"
fi

fetch() {
  # $1 = asset name. Public releases via curl; private ones via an authenticated gh.
  # BOUNCER_RELEASE_DIR installs from a local folder of release artifacts (testing, air-gapped).
  if [ -n "${BOUNCER_RELEASE_DIR:-}" ]; then cp "$BOUNCER_RELEASE_DIR/$1" "$TMP/$1" && return 0; die "$1 not in $BOUNCER_RELEASE_DIR"; fi
  if [ -z "$TAG" ]; then url="https://github.com/$REPO/releases/latest/download/$1"
  else url="https://github.com/$REPO/releases/download/$TAG/$1"; fi
  if curl -fsSL --retry 3 -o "$TMP/$1" "$url" 2>/dev/null; then return 0; fi
  if command -v gh >/dev/null 2>&1; then
    gh release download ${TAG:+"$TAG"} --repo "$REPO" --pattern "$1" --dir "$TMP" --clobber && return 0
  fi
  die "could not download $1 (is the repo private? install and log in to the GitHub CLI: gh auth login)"
}

say "Fetching release checksums…"
fetch SHA256SUMS
ASSET="$(grep -o "bouncer-[^ ]*-darwin-$ARCH\.tar\.gz" "$TMP/SHA256SUMS" | head -1)"
[ -n "$ASSET" ] || die "no darwin-$ARCH build in this release"

say "Downloading ${ASSET}…"
fetch "$ASSET"
(cd "$TMP" && grep " $ASSET\$" SHA256SUMS | shasum -a 256 -c - >/dev/null) || die "checksum mismatch for $ASSET; refusing to install"

tar -C "$TMP" -xzf "$TMP/$ASSET"
BIN="$(find "$TMP" -type f -name bouncer -perm -u+x | head -1)"
[ -n "$BIN" ] || die "archive did not contain the bouncer binary"

say "Installing…"
"$BIN" install

if [ "$WITH_APP" = 1 ]; then
  APPZIP="$(grep -o 'Bouncer-[^ ]*\.app\.zip' "$TMP/SHA256SUMS" | head -1)"
  if [ -n "$APPZIP" ]; then
    say "Installing the menu bar app…"
    fetch "$APPZIP"
    (cd "$TMP" && grep " $APPZIP\$" SHA256SUMS | shasum -a 256 -c - >/dev/null) || die "checksum mismatch for $APPZIP"
    mkdir -p "$HOME/Applications"
    pkill -f 'Bouncer.app/Contents/MacOS/BouncerBar' 2>/dev/null || true
    rm -rf "$HOME/Applications/Bouncer.app"
    ditto -x -k "$TMP/$APPZIP" "$HOME/Applications"
    open "$HOME/Applications/Bouncer.app" || true
  fi
fi

say "Done. Open a new terminal, then run: bouncer doctor"
