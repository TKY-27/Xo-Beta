#!/bin/sh
# Verify that every redistributed production asset is listed exactly once and
# still matches its recorded SHA-256. Original branding/map captures are
# intentionally outside this third-party provenance ledger.
set -eu

cd "$(dirname "$0")/.."

asset_root=$(pwd)/public/assets
checksum_file=$(pwd)/docs/ASSET_CHECKSUMS.txt
expected=$(mktemp)
actual=$(mktemp)
checksum_rows=$(mktemp)
trap 'rm -f -- "$expected" "$actual" "$checksum_rows"' EXIT HUP INT TERM

for map in neocity oldfront eden ashara; do
  if [ ! -f "$asset_root/maps/$map.jpg" ]; then
    echo "asset audit FAILED — missing generated map hero: maps/$map.jpg"
    exit 1
  fi
done

awk 'NF >= 2 && $1 !~ /^#/ { print $2 }' "$checksum_file" | LC_ALL=C sort > "$expected"
find "$asset_root/sky" "$asset_root/textures" "$asset_root/models" \
  "$asset_root/audio" "$asset_root/fonts" -type f -print \
  | sed "s#^$asset_root/##" | LC_ALL=C sort > "$actual"

if ! cmp -s "$expected" "$actual"; then
  echo "asset audit FAILED — checksum ledger and production files differ"
  echo "unlisted production assets:"
  comm -13 "$expected" "$actual"
  echo "missing production assets:"
  comm -23 "$expected" "$actual"
  exit 1
fi

awk 'NF >= 2 && $1 !~ /^#/ { print $1 "  " $2 }' "$checksum_file" > "$checksum_rows"
if ! (cd "$asset_root" && shasum -a 256 -c "$checksum_rows" >/dev/null); then
  echo "asset audit FAILED — one or more SHA-256 checksums changed"
  exit 1
fi

count=$(wc -l < "$expected" | tr -d ' ')
echo "asset audit: $count production files listed and verified"
