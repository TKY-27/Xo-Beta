#!/bin/sh
# Audit the water presentation boundary. This intentionally scans executable
# source and bundle files, not package lockfiles, notices, or documentation.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/xo-water-audit.XXXXXX")
trap 'rm -rf -- "$tmp_dir"' EXIT HUP INT TERM

fail=0

report_matches() {
  label=$1
  pattern=$2
  files=$3
  insensitive=${4:-0}
  matches="$tmp_dir/matches"
  : > "$matches"
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    if [ "$insensitive" -eq 1 ]; then
      if grep -nEi "$pattern" "$file" >> "$matches" 2>/dev/null; then
        :
      fi
    else
      if grep -nE "$pattern" "$file" >> "$matches" 2>/dev/null; then
        :
      fi
    fi
  done < "$files"
  if [ -s "$matches" ]; then
    echo "water provenance audit FAILED — $label"
    sed -n '1,40p' "$matches"
    fail=1
  fi
}

write_code_files() {
  root=$1
  output=$2
  : > "$output"
  [ -d "$root" ] || return 0
  find "$root" -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \
       -o -name '*.cjs' -o -name '*.html' -o -name '*.css' -o -name '*.json' \) \
    ! -path '*/docs/*' ! -path '*/documentation/*' \
    ! -name '*.lock' ! -name 'package-lock.json' \
    -print >> "$output"
}

write_water_module_files() {
  output=$1
  : > "$output"
  [ -d src/render ] || return 0
  find src/render -type f \
    \( -iname '*water*.ts' -o -iname '*water*.tsx' -o -iname '*water*.js' \
       -o -iname '*water*.mjs' \) \
    ! -path '*/docs/*' -print >> "$output"
}

# A .gitmodules file or a mode-160000 index entry would make upstream source
# provenance opaque and is not permitted for this presentation-only feature.
if [ -e .gitmodules ]; then
  echo "water provenance audit FAILED — .gitmodules is present"
  fail=1
fi

gitlinks=$(git ls-files --stage | awk '$1 == "160000" { print }')
if [ -n "$gitlinks" ]; then
  echo "water provenance audit FAILED — gitlink entries are present"
  printf '%s\n' "$gitlinks"
  fail=1
fi

write_code_files src "$tmp_dir/src-files"
write_code_files public "$tmp_dir/public-files"
write_code_files dist "$tmp_dir/dist-files"

# No WebGPU/WGSL runtime is allowed in the existing WebGL2 renderer path or in
# the executable bundle. The extension check catches an asset even when it is
# not referenced by source.
for root in src public dist; do
  if [ -d "$root" ] && find "$root" -type f -iname '*.wgsl' -print | grep -q .; then
    echo "water provenance audit FAILED — WGSL asset found below $root"
    find "$root" -type f -iname '*.wgsl' -print
    fail=1
  fi
done
report_matches \
  'WebGPU or WGSL runtime reference found' \
  'navigator[.]gpu|WebGPURenderer|GPUDevice|[Ww][Gg][Ss][Ll]' \
  "$tmp_dir/src-files"
report_matches \
  'WebGPU or WGSL bundle reference found' \
  'navigator[.]gpu|WebGPURenderer|GPUDevice|[Ww][Gg][Ss][Ll]' \
  "$tmp_dir/public-files"
report_matches \
  'WebGPU or WGSL bundle reference found' \
  'navigator[.]gpu|WebGPURenderer|GPUDevice|[Ww][Gg][Ss][Ll]' \
  "$tmp_dir/dist-files"

# Keep upstream implementation provenance out of shipped executable files.
# Existing OFL notices, THIRD_PARTY_NOTICES, and docs are deliberately outside
# the code lists above. The project home link in dist/index.html is the one
# intentional GitHub URL in the production shell; all other raw GitHub URLs
# and upstream names are rejected.
report_matches \
  'gpuocean/tompng/raw GitHub provenance string found' \
  'gpuocean|tompng|raw[.]githubusercontent[.]com' \
  "$tmp_dir/src-files" 1
report_matches \
  'gpuocean/tompng/raw GitHub provenance string found' \
  'gpuocean|tompng|raw[.]githubusercontent[.]com' \
  "$tmp_dir/public-files" 1
report_matches \
  'gpuocean/tompng/raw GitHub provenance string found' \
  'gpuocean|tompng|raw[.]githubusercontent[.]com' \
  "$tmp_dir/dist-files" 1

github_files="$tmp_dir/github-files"
cat "$tmp_dir/src-files" "$tmp_dir/public-files" > "$github_files"
if [ -s "$tmp_dir/dist-files" ]; then
  # dist/index.html contains the repository's canonical project link. It is
  # checked separately so an unrelated raw GitHub URL cannot be smuggled into
  # the production shell.
  grep -v '^dist/index[.]html$' "$tmp_dir/dist-files" >> "$github_files" || true
fi
report_matches \
  'unexpected GitHub URL found in executable production files' \
  'github[.]com|github[.]io' \
  "$github_files" 1
if [ -f dist/index.html ] && grep -E -i 'github[.]com|github[.]io' dist/index.html \
  | grep -Ev 'https://github[.]com/TKY-27/Xo-Beta(["/]|$)' >/dev/null 2>&1; then
  echo "water provenance audit FAILED — unexpected GitHub URL found in dist/index.html"
  grep -nE -i 'github[.]com|github[.]io' dist/index.html | sed -n '1,20p'
  fail=1
fi

# The new water renderer must remain a presentation-only WebGL2 consumer. It
# may use Three.js resources, but it must not create a second renderer/canvas
# or establish a network/server path.
write_water_module_files "$tmp_dir/water-files"
if [ -s "$tmp_dir/water-files" ]; then
  report_matches \
    'water module creates a renderer or canvas' \
    'new[[:space:]]+([[:alnum:]_]+[.])?WebGLRenderer|createElement[[:space:]]*[(][^)]*canvas|new[[:space:]]+OffscreenCanvas' \
    "$tmp_dir/water-files"
  report_matches \
    'water module contains a network/server path' \
    '(^|[^[:alnum:]_])(fetch|XMLHttpRequest|WebSocket|EventSource)([^[:alnum:]_]|$)|https?://|wss?://|raw[.]githubusercontent[.]com|/net/|/network/|/server/|/signaling/|/transport/|/relay/|/ice/' \
    "$tmp_dir/water-files"
  water_count=$(wc -l < "$tmp_dir/water-files" | tr -d ' ')
  echo "water provenance audit: $water_count dedicated water renderer module(s) checked"
else
  echo "water provenance audit: no dedicated water renderer module found (pre-implementation check)"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

if [ -d dist ]; then
  dist_state='dist checked'
else
  dist_state='dist not present; bundle check deferred until build'
fi
src_count=$(wc -l < "$tmp_dir/src-files" | tr -d ' ')
echo "water provenance audit: clean; $src_count executable source file(s); $dist_state"
