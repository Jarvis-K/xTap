#!/bin/bash
# xTap — installer for the native messaging host (macOS / Linux).
# Usage: ./install.sh <chrome-extension-id>

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <chrome-extension-id>"
  echo "  Find your extension ID at chrome://extensions (enable Developer mode)"
  exit 1
fi

EXT_ID="$1"
HOST_NAME="com.xtap.host"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="${SCRIPT_DIR}/xtap_host.py"

OS="$(uname)"
case "$OS" in
  Darwin)
    TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    TARGET_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  *)
    echo "Error: Unsupported OS '$OS'. Use install.ps1 on Windows."
    exit 1
    ;;
esac
MANIFEST_PATH="${TARGET_DIR}/${HOST_NAME}.json"

# Verify python3
if ! command -v python3 &> /dev/null; then
  echo "Error: python3 is required but not found in PATH"
  exit 1
fi

# Make host executable
chmod +x "$HOST_PATH"

# Create target directory
mkdir -p "$TARGET_DIR"

# Write manifest
cat > "$MANIFEST_PATH" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "xTap native messaging host — writes captured tweets to JSONL",
  "path": "${HOST_PATH}",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://${EXT_ID}/"]
}
EOF

echo "Installed native messaging host manifest to:"
echo "  $MANIFEST_PATH"
echo ""
echo "Host script: $HOST_PATH"
echo "Extension ID: $EXT_ID"
echo ""
echo "Output directory (set XTAP_OUTPUT_DIR to change):"
echo "  ${XTAP_OUTPUT_DIR:-$HOME/Downloads/xtap}"
