#!/bin/sh
# Validate the exact static bundle prepared for Cloudflare Workers Assets.
set -eu
cd "$(dirname "$0")/.."

if [ ! -f dist/index.html ] || [ ! -f dist/_headers ]; then
  echo "dist audit FAILED — run npm run build first"
  exit 1
fi

for required in \
  dist/LICENSE \
  dist/THIRD_PARTY_NOTICES.md \
  dist/docs/ASSET_MANIFEST.md \
  dist/docs/ASSET_CHECKSUMS.txt; do
  if [ ! -f "$required" ]; then
    echo "dist audit FAILED — missing $required"
    exit 1
  fi
done

# SPA fallbacks are served at arbitrary deep paths. Relative bundle URLs such
# as ./assets/app.js would resolve below that route and return the HTML fallback
# instead of JavaScript, so the production shell must use origin-root URLs.
if grep -E -q '(src|href)="(\./)?assets/' dist/index.html; then
  echo "dist audit FAILED — relative asset URL breaks deep SPA routes"
  exit 1
fi
if ! grep -E -q '(src|href)="/assets/' dist/index.html; then
  echo "dist audit FAILED — production shell has no origin-root asset URLs"
  exit 1
fi

if find dist -type l -print | grep -q .; then
  echo "dist audit FAILED — symbolic links are not allowed"
  find dist -type l -print
  exit 1
fi

oversized=$(find dist -type f -size +26214400c -print)
if [ -n "$oversized" ]; then
  echo "dist audit FAILED — Cloudflare's 25 MiB per-file limit is exceeded"
  printf '%s\n' "$oversized"
  exit 1
fi

file_count=$(find dist -type f | wc -l | tr -d ' ')
if [ "$file_count" -gt 20000 ]; then
  echo "dist audit FAILED — Cloudflare free-plan asset count exceeded: $file_count"
  exit 1
fi

if find dist \( -type d -o -type f \) \
  \( -path '*/qa/*' -o -path '*/.qa-tmp/*' -o -path '*/shots/*' \) \
  -print | grep -q .; then
  echo "dist audit FAILED — local QA paths leaked into dist"
  exit 1
fi

if grep -R -E -q \
  '__xo(State|Teleport|Stress|Give|QaInput|Storm|Rigs|LobbyRig|FreezeRigs|Aerial)|xoQaPosition|CODEX-INTERNAL-BROWSER-QA|FINAL-QA-LEDGER|VISUAL-QA-LEDGER' \
  dist; then
  echo "dist audit FAILED — development hooks or local QA artifacts leaked into dist"
  exit 1
fi

# Multiplayer is direct-P2P and STUN-only. Scan executable production assets,
# not documentation that explains the forbidden schemes.
if find dist/assets -type f -name '*.js' -print0 \
  | xargs -0 grep -E -i -q 'turns?:'; then
  echo "dist audit FAILED — TURN URI scheme found in production JavaScript"
  exit 1
fi

if find dist/assets -type f -name '*.js' -print0 \
  | xargs -0 grep -E -q '(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36})'; then
  echo "dist audit FAILED — provider credential pattern found in production JavaScript"
  exit 1
fi

if find dist/assets -type f -name '*.js' -print0 \
  | xargs -0 grep -E -q '#join=[0-9A-HJKMNP-TV-Z]{80,}'; then
  echo "dist audit FAILED — invite-secret token literal found in production JavaScript"
  exit 1
fi

unexpected_websockets=$(
  find dist/assets -type f -name '*.js' -print0 \
    | xargs -0 grep -Eho 'wss://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+' \
    | sort -u \
    | grep -Ev '^(wss://nos\.lol|wss://relay\.agorist\.space|wss://relay\.mostro\.network|wss://schnorr\.me)$' \
    || true
)
if [ -n "$unexpected_websockets" ]; then
  echo "dist audit FAILED — unexpected WebSocket endpoint found in production JavaScript"
  printf '%s\n' "$unexpected_websockets"
  exit 1
fi

if find dist/assets -type f -name '*.js' -print0 \
  | xargs -0 grep -E -i -q '(realtime\.cloudflare\.com|\.workers\.dev|\.pages\.dev/api/|supabase|firebaseio|/api/(room|lobby|matchmaking))'; then
  echo "dist audit FAILED — unintended multiplayer server endpoint found in production JavaScript"
  exit 1
fi

header_rules=$(awk '/^[^[:space:]#]/ { count++ } END { print count + 0 }' dist/_headers)
if [ "$header_rules" -gt 100 ]; then
  echo "dist audit FAILED — Cloudflare _headers rule limit exceeded: $header_rules"
  exit 1
fi
if awk 'length($0) > 2000 { exit 1 }' dist/_headers; then :; else
  echo "dist audit FAILED — Cloudflare _headers line limit exceeded"
  exit 1
fi

for required_header in \
  "Content-Security-Policy: default-src 'self'" \
  "Cache-Control: no-cache" \
  "! Cache-Control" \
  "Cache-Control: public, max-age=31536000, immutable"; do
  if ! grep -F -q "$required_header" dist/_headers; then
    echo "dist audit FAILED — missing required header rule: $required_header"
    exit 1
  fi
done

echo "dist audit: $file_count files; static-only bundle has no forbidden relay, credential, invite or endpoint literals"
