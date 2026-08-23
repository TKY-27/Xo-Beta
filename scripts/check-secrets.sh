#!/bin/sh
# Lightweight secret scan: fails if likely credentials are committed.
# Intentionally pattern-based and dependency-free; tuned for this repo.
set -eu
cd "$(dirname "$0")/.."

PATTERNS='(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|CF_API_TOKEN=|AWS_SECRET_ACCESS_KEY=)'

FILES=$(git ls-files -z --cached --others --exclude-standard \
  | tr '\0' '\n' \
  | grep -vE '(^|/)(node_modules|dist|qa|\.wrangler)/' \
  | grep -v '^scripts/check-secrets.sh$' \
  | grep -vE '\.(png|jpg|jpeg|gif|webp|hdr|glb|gltf|bin|wav|ogg|mp3|7z|zip|ico|woff2?)$' \
  || true)

if [ -z "$FILES" ]; then
  echo "secret scan: no candidate files"
  exit 0
fi

MATCHES=$(printf '%s\n' "$FILES" | tr '\n' '\0' | xargs -0 grep -nE "$PATTERNS" -- 2>/dev/null || true)

if [ -n "$MATCHES" ]; then
  echo "secret scan FAILED — review the following matches:"
  printf '%s\n' "$MATCHES"
  exit 1
fi
echo "secret scan: clean"
