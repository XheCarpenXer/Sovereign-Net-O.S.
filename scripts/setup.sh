#!/usr/bin/env bash
# ============================================================
# SOVEREIGN NET OS — Setup Script
# Run from the sovereign-net-electron/ directory.
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   SOVEREIGN NET OS — Electron Setup          ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── 1. Check Node ──────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "✗ Node.js not found. Install from https://nodejs.org (v18+ recommended)"
  exit 1
fi
NODE_VER=$(node --version)
echo "✓ Node $NODE_VER"

# ── 2. Install npm deps ────────────────────────────────────
echo ""
echo "→ Installing npm dependencies…"
npm install
echo "✓ Dependencies installed"

# ── 3. Check for Kubo / go-ipfs ───────────────────────────
echo ""
echo "→ Checking for Kubo (go-ipfs) daemon…"
if command -v ipfs &>/dev/null; then
  IPFS_VER=$(ipfs version 2>/dev/null | head -1 || echo "unknown")
  echo "✓ Found ipfs: $IPFS_VER"
else
  echo ""
  echo "⚠  Kubo not found in PATH."
  echo "   Install it for real IPFS functionality:"
  echo ""
  echo "   macOS:   brew install ipfs"
  echo "   Linux:   https://docs.ipfs.tech/install/command-line/"
  echo "   Windows: https://docs.ipfs.tech/install/command-line/"
  echo ""
  echo "   OR: download IPFS Desktop (includes Kubo) from:"
  echo "   https://github.com/ipfs/ipfs-desktop/releases"
  echo ""
  echo "   The app will run in simulation mode without Kubo."
fi

# ── 4. Copy/link index.html into place ────────────────────
echo ""
echo "→ Checking for index.html…"
if [ -f "index.html" ]; then
  echo "✓ index.html already present"
else
  # Look one level up (e.g. if index.html is the project root)
  if [ -f "../index.html" ]; then
    cp "../index.html" "index.html"
    echo "✓ Copied ../index.html → index.html"
  else
    echo "⚠  index.html not found. Place your Sovereign Net OS index.html in:"
    echo "   $SCRIPT_DIR/index.html"
  fi
fi

# ── 5. Inject the IPFS adapter script tag ─────────────────
echo ""
echo "→ Injecting IPFS adapter into index.html…"
if grep -q 'ipfsAdapter.js' index.html 2>/dev/null; then
  echo "✓ Adapter already injected"
else
  if grep -q '</body>' index.html 2>/dev/null; then
    if sed --version 2>/dev/null | grep -q GNU; then
      sed -i 's|</body>|<script src="src/ipfsAdapter.js"></script>\n</body>|' index.html
    else
      sed -i '' 's|</body>|<script src="src/ipfsAdapter.js"></script>\
</body>|' index.html
    fi
    echo "✓ Injected <script src=\"src/ipfsAdapter.js\"></script> before </body>"
  else
    echo "⚠  Could not find </body> in index.html — add manually:"
    echo '   <script src="src/ipfsAdapter.js"></script>'
  fi
fi

# ── 6. Inject ENOSStorage — unified IndexedDB API ──────────
# Must come before ext-host.js so api.storage is ready when modules boot.
echo ""
echo "→ Injecting ENOSStorage…"
if grep -q 'enos-storage.js' index.html 2>/dev/null; then
  echo "✓ ENOSStorage already injected"
else
  if grep -q '</body>' index.html 2>/dev/null; then
    if sed --version 2>/dev/null | grep -q GNU; then
      sed -i 's|</body>|<script src="src/enos-storage.js"></script>\n</body>|' index.html
    else
      sed -i '' 's|</body>|<script src="src/enos-storage.js"></script>\
</body>|' index.html
    fi
    echo "✓ Injected <script src=\"src/enos-storage.js\"></script> before </body>"
  else
    echo "⚠  Could not find </body> — add manually: <script src=\"src/enos-storage.js\"></script>"
  fi
fi

# ── 7. Inject ext-host — module extension bus ──────────────
echo ""
echo "→ Injecting ext-host…"
if grep -q 'ext-host.js' index.html 2>/dev/null; then
  echo "✓ ext-host already injected"
else
  if grep -q '</body>' index.html 2>/dev/null; then
    if sed --version 2>/dev/null | grep -q GNU; then
      sed -i 's|</body>|<script src="src/ext-host.js"></script>\n</body>|' index.html
    else
      sed -i '' 's|</body>|<script src="src/ext-host.js"></script>\
</body>|' index.html
    fi
    echo "✓ Injected <script src=\"src/ext-host.js\"></script> before </body>"
  else
    echo "⚠  Could not find </body> — add manually: <script src=\"src/ext-host.js\"></script>"
  fi
fi

# ── 8. Inject modules from the modules/ directory ──────────
# To add a new module: drop a .js file in modules/ and re-run setup.sh.
# The loop below injects each one if not already present.
echo ""
echo "→ Scanning modules/ directory…"
MODULES_DIR="$SCRIPT_DIR/../modules"
if [ -d "$MODULES_DIR" ]; then
  INJECTED=0
  for mod in "$MODULES_DIR"/*.js; do
    # Skip the host files themselves (they're in src/, already handled above)
    filename=$(basename "$mod")
    if [[ "$filename" == "enos-storage.js" || "$filename" == "ext-host.js" || "$filename" == "setup.sh" ]]; then
      continue
    fi
    if grep -q "$filename" index.html 2>/dev/null; then
      echo "  ✓ $filename already injected"
    else
      if sed --version 2>/dev/null | grep -q GNU; then
        sed -i "s|</body>|<script src=\"modules/${filename}\"></script>\n</body>|" index.html
      else
        sed -i '' "s|</body>|<script src=\"modules/${filename}\"></script>\
</body>|" index.html
      fi
      echo "  ✓ Injected modules/$filename"
      INJECTED=$((INJECTED + 1))
    fi
  done
  if [ $INJECTED -eq 0 ] && ! ls "$MODULES_DIR"/*.js 2>/dev/null | grep -qv "enos-storage\|ext-host"; then
    echo "  (no extra modules found — drop .js files in modules/ to auto-inject)"
  fi
else
  echo "  (no modules/ directory found — create it to start adding modules)"
fi

# ── Done ───────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   Setup complete!                            ║"
echo "║                                              ║"
echo "║   Start the app:   npm start                 ║"
echo "║   Dev mode:        npm run dev               ║"
echo "║   Build for dist:  npm run build:mac         ║"
echo "║                                              ║"
echo "║   Add modules:     drop .js in modules/      ║"
echo "║                    re-run setup.sh           ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
