#!/bin/sh
# Build release artifacts into dist/release/:
#   bouncer-<version>-darwin-arm64.tar.gz, bouncer-<version>-darwin-x64.tar.gz,
#   Bouncer-<version>.app.zip, install.sh, SHA256SUMS
#
# Signing and notarization switch on only when their environment is present:
#   BOUNCER_SIGN_IDENTITY   "Developer ID Application: Name (TEAMID)" in the current keychain
#   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD   notarytool credentials (app-specific password)
set -eu
cd "$(dirname "$0")/.."

VERSION="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' package.json | head -1)"
OUT="$(pwd)/dist/release"
rm -rf "$OUT" && mkdir -p "$OUT"
SIGN="${BOUNCER_SIGN_IDENTITY:-}"
NOTARIZE=0
[ -n "$SIGN" ] && [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ] && NOTARIZE=1

notarize() {
  [ "$NOTARIZE" = 1 ] || return 0
  xcrun notarytool submit "$1" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
}

for ARCH in arm64 x64; do
  DIR="$OUT/bouncer-$VERSION-darwin-$ARCH"
  mkdir -p "$DIR"
  # Never autoload .env/bunfig: the binary runs inside users' projects.
  bun build src/main.ts --compile --target="bun-darwin-$ARCH" \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile "$DIR/bouncer"
  if [ -n "$SIGN" ]; then
    codesign --force --options runtime --timestamp --entitlements scripts/entitlements.plist --sign "$SIGN" "$DIR/bouncer"
    codesign --verify --verbose "$DIR/bouncer"
  fi
  cp LICENSE README.md "$DIR/"
  if [ "$NOTARIZE" = 1 ]; then
    # Bare binaries can't be stapled; notarizing still lets Gatekeeper find the ticket online.
    ditto -c -k --keepParent "$DIR/bouncer" "$DIR.notarize.zip"
    notarize "$DIR.notarize.zip"
    rm "$DIR.notarize.zip"
  fi
  tar -C "$OUT" -czf "$DIR.tar.gz" "$(basename "$DIR")"
  rm -rf "$DIR"
done

menubar/build.sh --out "$OUT" --universal
APPZIP="$OUT/Bouncer-$VERSION.app.zip"
ditto -c -k --keepParent "$OUT/Bouncer.app" "$APPZIP"
if [ "$NOTARIZE" = 1 ]; then
  notarize "$APPZIP"
  xcrun stapler staple "$OUT/Bouncer.app"
  rm "$APPZIP" && ditto -c -k --keepParent "$OUT/Bouncer.app" "$APPZIP"
fi
rm -rf "$OUT/Bouncer.app"

cp scripts/install.sh "$OUT/install.sh"
(cd "$OUT" && shasum -a 256 ./*.tar.gz ./*.zip install.sh | sed 's# \./# #' > SHA256SUMS)
echo "release artifacts for v$VERSION (signed: ${SIGN:+yes}${SIGN:-no}, notarized: $NOTARIZE):"
ls -la "$OUT"
