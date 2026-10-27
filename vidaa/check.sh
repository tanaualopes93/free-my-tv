#!/usr/bin/env bash
# Checks the VIDAA side before anything is published (publicar.sh and .githooks/pre-push run it):
#
#   vidaa/check.sh              # syntax, calls newer than Chrome 111, catalogue, secrets
#   vidaa/check.sh --online     # also: every app address and every published icon answers 200
#   vidaa/check.sh --strict     # a missing file is an error (without it, files another step hasn't made yet are skipped)
set -euo pipefail
cd "$(dirname "$0")/.."
online=""; strict=""
for a in "$@"; do
  case "$a" in
    --online) online="--online" ;;
    --strict) strict=1 ;;
    *) echo "Usage: vidaa/check.sh [--online] [--strict]" >&2; exit 2 ;;
  esac
done
PY="${PYTHON:-python}"
command -v "$PY" >/dev/null 2>&1 || PY=python3
fail=0
bad() { echo "$*" >&2; fail=1; }

# The VIDAA TV runs Chrome 111 (ARMv7); the registry also runs in web/'s world, so it stays ES5.
parse() {   # parse <ecma> <file>
  if [ ! -f "$2" ]; then
    if [ -n "$strict" ]; then bad "Missing: $2"; else echo "skip (not there yet): $2"; fi
    return 0
  fi
  npx --yes acorn@8.14.0 --ecma"$1" --silent "$2" || bad "Syntax error ($1): $2"
}
parse 5 vidaa/store/registry.js
parse 2022 vidaa/store/store.js
for f in vidaa/shell/*.js; do [ -f "$f" ] && parse 2022 "$f"; done || true
if [ -z "$(ls vidaa/shell/*.js 2>/dev/null)" ]; then
  if [ -n "$strict" ]; then bad "Missing: vidaa/shell/*.js"; else echo "skip (not there yet): vidaa/shell/*.js"; fi
fi

# Calls that parse fine but the TV's Chrome may not have (toSorted and the like are 110 on paper, groupBy is 117,
# withResolvers 119): kept out on purpose. findLast (97), at (92), structuredClone (98) and :has() (105) are fine.
js_files="$(ls vidaa/store/registry.js vidaa/store/store.js vidaa/shell/*.js 2>/dev/null || true)"
if [ -n "$js_files" ]; then
  # shellcheck disable=SC2086
  if grep -nE '\.(toSorted|toReversed|toSpliced|isWellFormed|toWellFormed)\(|\.with\(|Object\.groupBy\(|Map\.groupBy\(|Promise\.withResolvers\(|Array\.fromAsync\(' $js_files; then
    bad "VIDAA code calls something newer than Chrome 111 (above)."
  fi
fi
css_files="$(ls vidaa/store/*.css vidaa/shell/*.css 2>/dev/null || true)"
if [ -n "$css_files" ]; then
  # CSS nesting (Chrome 120), text-wrap, @starting-style, light-dark(), @scope, field-sizing: all newer than 111.
  # shellcheck disable=SC2086
  if grep -nE '(^|[{;])[[:space:]]*&|text-wrap[[:space:]]*:|@starting-style|light-dark\(|@scope|field-sizing[[:space:]]*:' $css_files; then
    bad "VIDAA CSS uses something newer than Chrome 111 (above)."
  fi
fi

# The catalogue: schema, icons (400 x 400 PNG, up to 40 KB) and, with --online, the addresses.
if [ -f vidaa/store/catalogo.json ]; then
  "$PY" -I vidaa/check_catalogo.py $online || fail=1
elif [ -n "$strict" ]; then
  bad "Missing: vidaa/store/catalogo.json"
else
  echo "skip (not there yet): vidaa/store/catalogo.json"
fi

# Nothing private in what is tracked, what would be, or what is built: no key, no home address, no TMDB key.
scan() {   # scan <label> <regex> <files...>
  local label="$1" re="$2"; shift 2
  if [ "$#" -gt 0 ] && grep -InE -e "$re" -- "$@" 2>/dev/null; then bad "Found $label (above)."; fi
}
files=()
while IFS= read -r f; do
  case "$f" in vidaa/check.sh|.githooks/*) continue ;; esac
  [ -f "$f" ] && files+=("$f")
done < <(git ls-files -co --exclude-standard)
if [ -d out/vidaa ]; then
  while IFS= read -r f; do files+=("$f"); done < <(find out/vidaa -type f ! -name '*.png' ! -name '*.ttf' ! -name '*.woff*')
fi
scan "a private key" '-----BEGIN [A-Z ]*PRIVATE KEY-----' "${files[@]}"
scan "the home network address" '192\.168\.15\.[0-9]*[1-9]' "${files[@]}"
scan "a TMDB key" 'tmdbKey"[[:space:]]*:[[:space:]]*"[^"]' "${files[@]}"

if [ "$fail" -ne 0 ]; then echo "VIDAA checks failed." >&2; exit 1; fi
echo "VIDAA checks passed."
