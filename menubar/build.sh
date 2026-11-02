#!/bin/sh
# Build Bouncer.app (the menu bar app).
#
#   menubar/build.sh                         → ~/Applications/Bouncer.app, ad-hoc signed
#   menubar/build.sh --out DIR --universal   → DIR/Bouncer.app, arm64 + x86_64 (release builds)
#
# Set BOUNCER_SIGN_IDENTITY ("Developer ID Application: …") to sign for distribution with the
# hardened runtime; otherwise the app is ad-hoc signed, which is fine for local use.
set -eu
cd "$(dirname "$0")"

OUT="$HOME/Applications"
UNIVERSAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --universal) UNIVERSAL=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

VERSION="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' ../package.json | head -1)"
ARCH_FLAGS=""
[ "$UNIVERSAL" = 1 ] && ARCH_FLAGS="--arch arm64 --arch x86_64"

# Local builds go through Bouncer's own gate when it's installed.
BUILD="swift build -c release $ARCH_FLAGS"
if [ -x "$HOME/.bouncer/bouncer" ] && [ -z "${CI:-}" ]; then
  # shellcheck disable=SC2086
  "$HOME/.bouncer/bouncer" run --slot xcode -- $BUILD
else
  # shellcheck disable=SC2086
  $BUILD
fi
BIN="$(swift build -c release $ARCH_FLAGS --show-bin-path)/BouncerBar"

APP="$OUT/Bouncer.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/BouncerBar"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Bouncer</string>
  <key>CFBundleDisplayName</key><string>Bouncer</string>
  <key>CFBundleIdentifier</key><string>com.bouncer.menubar</string>
  <key>CFBundleExecutable</key><string>BouncerBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT License</string>
</dict>
</plist>
PLIST

if [ -n "${BOUNCER_SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$BOUNCER_SIGN_IDENTITY" "$APP"
else
  codesign --force --sign - "$APP" >/dev/null
fi
echo "built $APP ($VERSION)"
