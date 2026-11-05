#!/bin/bash
# Builds resources/icon.icns from resources/icon.svg. Needs macOS.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
npx electron tools/icon-main.cjs "$tmp/icon.png"
set_dir="$tmp/icon.iconset"
mkdir "$set_dir"
for s in 16 32 128 256 512; do
  sips -z $s $s "$tmp/icon.png" --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$tmp/icon.png" --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o resources/icon.icns
cp "$tmp/icon.png" resources/icon.png
rm -rf "$tmp"
echo "Wrote resources/icon.icns"
