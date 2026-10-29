#!/bin/bash
#
# build-sidestore-ipa.sh
#
# Build the native Happy iOS app as an unsigned, SideStore-importable IPA for
# first-time local development installation on a physical iPhone without a paid
# Apple Developer Program membership. SideStore applies the user's personal
# development signature on import.
#
# Default invocation (from the package directory):
#
#   cd packages/happy-ios
#   ./scripts/build-sidestore-ipa.sh
#
# The script works from any current directory. It builds the Happy Debug scheme
# for a generic physical iOS device with code signing and repository
# entitlements disabled for this invocation, then packages Happy.app as an IPA.
#
# Defaults:
#   bundle ID:     com.sunjiahui.happy.local
#   configuration: Debug
#   scheme:        Happy
#   SDK:           iphoneos
#   derived data:  <package>/.build-ios/sidestore-derived-data
#   output:        <package>/Happy-SideStore.ipa
#
# Options:
#   --bundle-id ID    Override PRODUCT_BUNDLE_IDENTIFIER (default above)
#   --output PATH     Write the IPA to PATH (must end in .ipa). A relative PATH
#                     is resolved from the current directory; the default is
#                     package-relative.
#   --help            Print this help and exit.
#
# Requires the macOS system Bash 3.2 feature set and system tools (xcodebuild,
# ditto, plutil, mktemp, unzip) plus XcodeGen. Dependencies are never installed
# automatically.
#
# Push notifications are intentionally unavailable in this build: the push
# entitlement is omitted. Foreground sync and the dynamic Codex/Claude/Kiro
# model catalogs remain available.

set -euo pipefail

# --- constants ---------------------------------------------------------------

DEFAULT_BUNDLE_ID="com.sunjiahui.happy.local"
SCHEME="Happy"
CONFIGURATION="Debug"
SDK="iphoneos"
DERIVED_DATA_REL=".build-ios/sidestore-derived-data"
PRODUCTS_SUBPATH="Build/Products/Debug-iphoneos"
APP_NAME="Happy.app"
MIN_XCODE_MAJOR=26

PROG="$(basename "$0")"

# --- helpers -----------------------------------------------------------------

die() {
    printf '%s: error: %s\n' "$PROG" "$*" >&2
    exit 1
}

info() {
    printf '%s\n' "$*" >&2
}

usage() {
    cat <<EOF
Usage: $PROG [--bundle-id ID] [--output PATH] [--help]

Build the native Happy iOS app as an unsigned, SideStore-importable IPA.

Options:
  --bundle-id ID   Override the product bundle identifier.
                   Default: $DEFAULT_BUNDLE_ID
  --output PATH    Write the IPA to PATH (must end in .ipa). A relative PATH is
                   resolved from the current directory; the default is
                   package-relative: <package>/Happy-SideStore.ipa
  --help           Print this help and exit.

The build disables code signing and the repository push entitlement for this
invocation. SideStore applies your personal development signature on import.
Push notifications are intentionally unavailable in this build.
EOF
}

# Resolve a directory to its absolute path without GNU readlink -f.
abspath_dir() {
    # $1: an existing directory
    ( cd "$1" && pwd )
}

# --- resolve script and package roots (independent of the caller) ------------

CALLER_PWD="$(pwd)"
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(abspath_dir "$(dirname "$SCRIPT_SOURCE")")"
PACKAGE_DIR="$(abspath_dir "$SCRIPT_DIR/..")"

# --- argument parsing --------------------------------------------------------

BUNDLE_ID="$DEFAULT_BUNDLE_ID"
OUTPUT=""   # empty means "use the package-relative default"

while [ $# -gt 0 ]; do
    case "$1" in
        --help|-h)
            usage
            exit 0
            ;;
        --bundle-id)
            [ $# -ge 2 ] || die "--bundle-id requires a value"
            BUNDLE_ID="$2"
            shift 2
            ;;
        --bundle-id=*)
            BUNDLE_ID="${1#*=}"
            shift
            ;;
        --output)
            [ $# -ge 2 ] || die "--output requires a value"
            OUTPUT="$2"
            shift 2
            ;;
        --output=*)
            OUTPUT="${1#*=}"
            shift
            ;;
        *)
            die "unknown argument: $1 (try --help)"
            ;;
    esac
done

# --- validate bundle identifier syntax ---------------------------------------
# Dot-separated nonempty ASCII components of letters, digits or hyphens, with at
# least two components.

if ! printf '%s' "$BUNDLE_ID" | grep -Eq '^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'; then
    die "invalid bundle id: '$BUNDLE_ID' (need dot-separated ASCII letters, digits or hyphens, at least two components)"
fi

# --- validate output path syntax and destination ----------------------------

if [ -z "$OUTPUT" ]; then
    OUTPUT_ABS="$PACKAGE_DIR/Happy-SideStore.ipa"
else
    case "$OUTPUT" in
        /*) OUTPUT_ABS="$OUTPUT" ;;                 # absolute
        *)  OUTPUT_ABS="$CALLER_PWD/$OUTPUT" ;;     # relative to the caller
    esac
fi

case "$OUTPUT_ABS" in
    *.ipa) : ;;
    *) die "output must end in .ipa: '$OUTPUT_ABS'" ;;
esac

OUTPUT_PARENT_RAW="$(dirname "$OUTPUT_ABS")"
OUTPUT_BASE="$(basename "$OUTPUT_ABS")"

if ! OUTPUT_PARENT="$(abspath_dir "$OUTPUT_PARENT_RAW" 2>/dev/null)"; then
    die "output parent directory does not exist: '$OUTPUT_PARENT_RAW'"
fi
[ -w "$OUTPUT_PARENT" ] || die "output parent directory is not writable: '$OUTPUT_PARENT'"

# Normalized absolute destination.
OUTPUT_ABS="$OUTPUT_PARENT/$OUTPUT_BASE"

# Reject a symlink or directory destination. An existing regular file is allowed
# and is replaced only after a complete new IPA passes validation.
if [ -L "$OUTPUT_ABS" ]; then
    die "output is a symlink, refusing to write through it: '$OUTPUT_ABS'"
fi
if [ -d "$OUTPUT_ABS" ]; then
    die "output is a directory: '$OUTPUT_ABS'"
fi
if [ -e "$OUTPUT_ABS" ] && [ ! -f "$OUTPUT_ABS" ]; then
    die "output exists and is not a regular file: '$OUTPUT_ABS'"
fi

# --- validate host and tools -------------------------------------------------
# Everything above is non-mutating and runs on any host. The checks below gate
# the expensive, macOS-only build.

[ "$(uname -s)" = "Darwin" ] || die "this script builds iOS apps and must run on macOS"

for tool in xcodebuild xcodegen ditto plutil mktemp unzip; do
    command -v "$tool" >/dev/null 2>&1 || die "required tool not found on PATH: $tool"
done

XCODE_VERSION_LINE="$(xcodebuild -version 2>/dev/null | sed -n '1s/^Xcode //p')"
XCODE_MAJOR="${XCODE_VERSION_LINE%%.*}"
case "$XCODE_MAJOR" in
    ''|*[!0-9]*) die "could not determine Xcode major version (got: '$XCODE_VERSION_LINE')" ;;
esac
[ "$XCODE_MAJOR" -ge "$MIN_XCODE_MAJOR" ] || die "Xcode $MIN_XCODE_MAJOR or newer required (found $XCODE_VERSION_LINE)"

# --- temp resources and cleanup ----------------------------------------------

PKG_DIR=""
TEMP_IPA=""

cleanup() {
    # Remove only the exact resources this script created. Never touch a
    # user-supplied path or the destination IPA.
    [ -n "$PKG_DIR" ] && [ -d "$PKG_DIR" ] && rm -rf "$PKG_DIR"
    [ -n "$TEMP_IPA" ] && [ -e "$TEMP_IPA" ] && rm -f "$TEMP_IPA"
    return 0
}
trap cleanup EXIT INT TERM

# --- generate the Xcode project ----------------------------------------------

info "==> Generating Xcode project with XcodeGen"
( cd "$PACKAGE_DIR" && xcodegen ) || die "xcodegen failed"

XCODEPROJ="$PACKAGE_DIR/$SCHEME.xcodeproj"
[ -d "$XCODEPROJ" ] || die "expected generated project not found: '$XCODEPROJ'"

# --- build the unsigned app --------------------------------------------------

DERIVED_DATA="$PACKAGE_DIR/$DERIVED_DATA_REL"

info "==> Building $SCHEME ($CONFIGURATION, $SDK) unsigned, bundle id $BUNDLE_ID"
( cd "$PACKAGE_DIR" && xcodebuild \
    -project "$SCHEME.xcodeproj" \
    -scheme "$SCHEME" \
    -configuration "$CONFIGURATION" \
    -sdk "$SDK" \
    -destination 'generic/platform=iOS' \
    -derivedDataPath "$DERIVED_DATA_REL" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY= \
    DEVELOPMENT_TEAM= \
    CODE_SIGN_ENTITLEMENTS= \
    PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
    build ) || die "xcodebuild failed"

APP_PATH="$DERIVED_DATA/$PRODUCTS_SUBPATH/$APP_NAME"
[ -d "$APP_PATH" ] || die "built app not found: '$APP_PATH'"

APP_PLIST="$APP_PATH/Info.plist"
[ -f "$APP_PLIST" ] || die "built app has no Info.plist: '$APP_PLIST'"

BUILT_BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw "$APP_PLIST" 2>/dev/null || true)"
[ "$BUILT_BUNDLE_ID" = "$BUNDLE_ID" ] || die "built app bundle id '$BUILT_BUNDLE_ID' does not match requested '$BUNDLE_ID'"

# The main app must carry no signing artifacts.
if [ -e "$APP_PATH/_CodeSignature" ]; then
    die "built app unexpectedly contains _CodeSignature"
fi
if [ -e "$APP_PATH/embedded.mobileprovision" ]; then
    die "built app unexpectedly contains embedded.mobileprovision"
fi

# --- package into a Payload/ IPA ---------------------------------------------

PKG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/happy-sidestore.XXXXXX")" || die "could not create temp packaging directory"

info "==> Assembling Payload"
mkdir -p "$PKG_DIR/Payload"
ditto "$APP_PATH" "$PKG_DIR/Payload/$APP_NAME" || die "failed to copy app into Payload"

# Create a uniquely named temporary archive in the destination directory so the
# final rename is atomic (same filesystem). Remove the placeholder so ditto
# writes a fresh archive to that name.
TEMP_IPA="$(mktemp "$OUTPUT_PARENT/.${OUTPUT_BASE}.XXXXXX")" || die "could not create temp IPA in destination directory"
rm -f "$TEMP_IPA"

info "==> Packaging IPA with ditto"
ditto -c -k --sequesterRsrc --keepParent "$PKG_DIR/Payload" "$TEMP_IPA" || die "ditto archive failed"

# --- validate the archive ----------------------------------------------------

info "==> Validating archive members"
MEMBERS="$(unzip -Z1 "$TEMP_IPA")" || die "could not list IPA members"

EXPECTED_PLIST="Payload/$APP_NAME/Info.plist"
if ! printf '%s\n' "$MEMBERS" | grep -Fxq "$EXPECTED_PLIST"; then
    die "IPA is missing the expected member: $EXPECTED_PLIST"
fi
if printf '%s\n' "$MEMBERS" | grep -Eq '(^|/)_CodeSignature(/|$)'; then
    die "IPA unexpectedly contains a _CodeSignature member"
fi
if printf '%s\n' "$MEMBERS" | grep -Eq '(^|/)embedded\.mobileprovision$'; then
    die "IPA unexpectedly contains an embedded.mobileprovision member"
fi

# Read the packaged bundle id back out of the archive to confirm it round-trips.
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/happy-sidestore-verify.XXXXXX")" || die "could not create verify directory"
if ! unzip -q "$TEMP_IPA" "$EXPECTED_PLIST" -d "$VERIFY_DIR" 2>/dev/null; then
    rm -rf "$VERIFY_DIR"
    die "could not extract packaged Info.plist for verification"
fi
PACKAGED_BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw "$VERIFY_DIR/$EXPECTED_PLIST" 2>/dev/null || true)"
rm -rf "$VERIFY_DIR"
[ "$PACKAGED_BUNDLE_ID" = "$BUNDLE_ID" ] || die "packaged bundle id '$PACKAGED_BUNDLE_ID' does not match requested '$BUNDLE_ID'"

# --- atomically replace the destination --------------------------------------

mv -f "$TEMP_IPA" "$OUTPUT_ABS" || die "failed to move validated IPA into place"
TEMP_IPA=""   # ownership transferred; cleanup must not touch it

IPA_BYTES="$(wc -c < "$OUTPUT_ABS" | tr -d '[:space:]')"

# --- report ------------------------------------------------------------------

cat <<EOF

==> SideStore IPA ready

  Path:       $OUTPUT_ABS
  Bundle ID:  $PACKAGED_BUNDLE_ID
  Size:       $IPA_BYTES bytes
  Xcode:      $XCODE_VERSION_LINE

To install: open SideStore on your iOS 26 device (or AltStore/SideStore on the
Mac with the device connected), choose "My Apps" -> "+", and select this IPA.
SideStore signs it with your personal development team. Free personal-team apps
expire after seven days and must be refreshed; push notifications are not
available in this build.
EOF
