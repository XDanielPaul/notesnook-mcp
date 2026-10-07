#!/usr/bin/env bash
# Fetches and builds the Notesnook monorepo packages used by notesnook-mcp,
# pinned to the tag matching the app/server version.
set -euo pipefail
TAG="${NOTESNOOK_TAG:-v3.4.9}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor/notesnook"

if [ ! -d "$DEST/.git" ]; then
  mkdir -p "$ROOT/vendor"
  git clone --depth 1 --branch "$TAG" --filter=blob:none --sparse \
    https://github.com/streetwriters/notesnook.git "$DEST"
fi
cd "$DEST"
if ! git describe --tags --exact-match HEAD 2>/dev/null | grep -qx "$TAG"; then
  git fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
  git checkout --detach "$TAG"
fi
git sparse-checkout set scripts packages/core packages/crypto packages/sodium \
  packages/logger packages/intl packages/streamable-fs packages/editor/scripts

# Node 26 no longer synthesizes ESM named exports for sodium-native's CJS addon.
node "$ROOT/scripts/patch-notesnook-sodium.mjs" "$DEST/packages/sodium/src/node.ts"

# Root dev tooling (typescript, tsdown, patch-package)
npm ci --ignore-scripts --no-audit --no-fund

cd packages
# sodium's lockfile is out of sync with npm 11, so use install
(cd sodium && npm install --no-audit --no-fund && npm run build)
(cd crypto && npm ci --no-audit --no-fund && npm run build)
(cd logger && npm ci --no-audit --no-fund && npm run build)
(cd intl && npm ci --legacy-peer-deps --no-audit --no-fund && npm run build)
# core's devDependency better-sqlite3-multiple-ciphers@11 doesn't build on Node >= 24;
# it's only needed for core's own tests, so skip install scripts and apply patches manually.
(cd core && npm ci --ignore-scripts --no-audit --no-fund && npx patch-package && npm run prebuild && npm run build)
echo "Notesnook $TAG packages built in $DEST"
