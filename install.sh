#!/bin/sh
# AION one-command installer for macOS / Linux
#   curl -fsSL https://raw.githubusercontent.com/razekeks1/aion/main/install.sh | sh
set -e
REPO="razekeks1/aion"

echo ""
echo "  AION installer"
echo "  --------------"

# ── Node.js >= 18 ────────────────────────────────────────
if command -v node >/dev/null 2>&1 && [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge 18 ]; then
  echo "  [ok] Node $(node -v)"
else
  echo "  Node.js >= 18 not found."
  if command -v brew >/dev/null 2>&1; then
    echo "  installing via Homebrew..."; brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    echo "  installing via apt (needs sudo)..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "  install Node.js LTS from https://nodejs.org and re-run."; exit 1
  fi
fi

# ── download + install ───────────────────────────────────
DEST="${HOME}/.local/share/aion"
echo "  downloading AION..."
rm -rf "$DEST"; mkdir -p "$DEST"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xz -C "$DEST" --strip-components=1
echo "  installing global 'aion' command..."
(cd "$DEST" && npm install -g . >/dev/null) || {
  echo "  npm -g failed (permissions?). Try:  sudo npm install -g \"$DEST\""
  exit 1
}

echo ""
echo "  [ok] done. Start with:  aion"
echo ""
