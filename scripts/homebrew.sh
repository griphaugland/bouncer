#!/bin/sh
# Render the Homebrew formula (CLI + daemon) and cask (menu bar app) for a release.
#
#   scripts/homebrew.sh [release-dir] [tap-dir]
#     release-dir  default dist/release (needs SHA256SUMS from scripts/package.sh)
#     tap-dir      default dist/homebrew-tap; writes Formula/bouncer.rb, Casks/bouncer-app.rb and cask_renames.json
#
# BOUNCER_DOWNLOAD_BASE overrides where Homebrew downloads from (e.g. file:///… for a local test).
set -eu
cd "$(dirname "$0")/.."

RELEASE="${1:-dist/release}"
TAP="${2:-dist/homebrew-tap}"
REPO="griphaugland/bouncer"
VERSION="$(sed -n 's/.*"version": "\(.*\)".*/\1/p' package.json | head -1)"
BASE="${BOUNCER_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download/v$VERSION}"

sum() { awk -v f="$1" '$2 == f { print $1 }' "$RELEASE/SHA256SUMS"; }
ARM="$(sum "bouncer-$VERSION-darwin-arm64.tar.gz")"
X64="$(sum "bouncer-$VERSION-darwin-x64.tar.gz")"
APP="$(sum "Bouncer-$VERSION.app.zip")"
[ -n "$ARM" ] && [ -n "$X64" ] && [ -n "$APP" ] || { echo "missing artifacts for $VERSION in $RELEASE/SHA256SUMS" >&2; exit 1; }

mkdir -p "$TAP/Formula" "$TAP/Casks"

cat > "$TAP/Formula/bouncer.rb" <<RUBY
class Bouncer < Formula
  desc "Queue heavy builds by memory pressure so many AI coding agents can share one Mac"
  homepage "https://github.com/$REPO"
  version "$VERSION"
  license "MIT"

  depends_on :macos

  on_macos do
    on_arm do
      url "$BASE/bouncer-$VERSION-darwin-arm64.tar.gz"
      sha256 "$ARM"
    end
    on_intel do
      url "$BASE/bouncer-$VERSION-darwin-x64.tar.gz"
      sha256 "$X64"
    end
  end

  def install
    bin.install "bouncer"
  end

  def caveats
    <<~EOS
      Finish setup (daemon, shims, Claude Code hooks):
        bouncer install

      Upgrades apply on their own: the daemon restarts onto the new version once no build is running.
      Remove everything with \`bouncer uninstall\` before \`brew uninstall bouncer\`.
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/bouncer --version").strip
    assert_match "bouncer", shell_output("#{bin}/bouncer help")
  end
end
RUBY

# The cask is "bouncer-app", not "bouncer": a formula and a cask with the same name make every
# `brew` command on it warn and guess. cask_renames.json moves anyone on the old name across.
cat > "$TAP/Casks/bouncer-app.rb" <<RUBY
cask "bouncer-app" do
  version "$VERSION"
  sha256 "$APP"

  url "$BASE/Bouncer-#{version}.app.zip"
  name "Bouncer"
  desc "Menu bar view of Bouncer's build queue and memory pressure"
  homepage "https://github.com/$REPO"

  depends_on formula: "griphaugland/tap/bouncer"
  depends_on macos: :sonoma

  app "Bouncer.app"

  uninstall quit: "com.bouncer.menubar"

  caveats <<~EOS
    The menu bar app shows the daemon installed by the bouncer formula. If you haven't yet:
      bouncer setup
  EOS
end
RUBY

printf '{\n  "bouncer": "bouncer-app"\n}\n' > "$TAP/cask_renames.json"

echo "wrote $TAP/Formula/bouncer.rb, $TAP/Casks/bouncer-app.rb and cask_renames.json for v$VERSION"
