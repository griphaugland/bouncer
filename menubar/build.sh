#!/bin/sh
# Build Bouncer.app (menu bar) into ~/Applications. Goes through Bouncer's own gate.
set -eu
cd "$(dirname "$0")"

BOUNCER="$HOME/.bouncer/bouncer"
if [ -x "$BOUNCER" ]; then
  "$BOUNCER" run --slot xcode -- swift build -c release
else
  swift build -c release
fi

APP="$HOME/Applications/Bouncer.app"
mkdir -p "$APP/Contents/MacOS"
cp .build/release/BouncerBar "$APP/Contents/MacOS/BouncerBar"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Bouncer</string>
  <key>CFBundleDisplayName</key><string>Bouncer</string>
  <key>CFBundleIdentifier</key><string>com.bouncer.menubar</string>
  <key>CFBundleExecutable</key><string>BouncerBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null
echo "built $APP"
