#!/usr/bin/env bash
# Publishes out/vidaa to the gh-pages branch of origin (GitHub Pages) and waits until the site shows the new build.
#
#   vidaa/publicar.sh           # check, build --generic, push, wait for the site (up to 12 min: Pages caches)
#   vidaa/publicar.sh --seco    # everything except the push (and the wait): what would go up
#   vidaa/publicar.sh --voltar  # republish the commit before the last one on gh-pages
#
# The site is always the generic build: no TMDB key, no city, no coordinates.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SITE="https://tanaualopes93.github.io/free-my-tv"
BRANCH="gh-pages"
WAIT_MAX=720   # seconds
dry=""; back=""
for a in "$@"; do
  case "$a" in
    --seco) dry=1 ;;
    --voltar) back=1 ;;
    *) echo "Usage: vidaa/publicar.sh [--seco] [--voltar]" >&2; exit 2 ;;
  esac
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
remote="$(git remote get-url origin)"

# Takes the clone of gh-pages in $work/site (or an empty repository if the branch doesn't exist yet).
clone_pages() {
  if git ls-remote --exit-code --heads "$remote" "$BRANCH" >/dev/null 2>&1; then
    git clone -q --branch "$BRANCH" --single-branch --depth 10 "$remote" "$work/site"
  else
    git init -q -b "$BRANCH" "$work/site"
    git -C "$work/site" remote add origin "$remote"
  fi
  git -C "$work/site" config core.autocrlf false   # the files go up byte for byte
}

wipe() {   # empties the working copy of gh-pages (not .git), so files that left the build leave the site
  find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
}

# Waits for config.js on the site to carry this build, as Pages takes a few minutes to show a push.
wait_site() {
  local want="$1" start now got
  start="$(date +%s)"
  echo "Waiting for $SITE/config.js to show $want (up to $((WAIT_MAX / 60)) min)..."
  while :; do
    got="$(curl -fsS --max-time 20 -H 'Cache-Control: no-cache' "$SITE/config.js?t=$start$RANDOM" 2>/dev/null || true)"
    case "$got" in *"\"buildVersion\": \"$want\""*) echo "Site is up with $want."; return 0 ;; esac
    now="$(date +%s)"
    if [ $((now - start)) -ge "$WAIT_MAX" ]; then
      echo "The site still doesn't show $want after $((WAIT_MAX / 60)) min. Check the Pages tab on GitHub." >&2
      return 1
    fi
    sleep 20
  done
}

build_of() {   # build_of <config.js>: its buildVersion
  python - "$1" <<'PY'
import json, sys
text = open(sys.argv[1], encoding='utf-8').read()
print(json.loads(text.split('window.CONFIG = ', 1)[1].rstrip().rstrip(';'))['buildVersion'])
PY
}

if [ -n "$back" ]; then
  clone_pages
  cd "$work/site"
  if ! git rev-parse -q --verify HEAD~1 >/dev/null; then echo "gh-pages has no earlier commit to go back to." >&2; exit 1; fi
  prev="$(git rev-parse --short HEAD~1)"
  wipe
  git checkout -q HEAD~1 -- .
  git add -A
  want="$(build_of config.js)"
  git commit -q -m "Go back to $prev (build $want)"
  if [ -n "$dry" ]; then echo "Dry run: would republish $prev (build $want)."; exit 0; fi
  git push -q origin "$BRANCH"
  wait_site "$want"
  exit 0
fi

# python3 for tools/check.sh (this PC only has python)
shim="$work/py3shim"; mkdir -p "$shim"
printf '#!/bin/sh\nexec python "$@"\n' > "$shim/python3"; chmod +x "$shim/python3"

echo "== VIDAA checks"
bash vidaa/check.sh --strict
echo "== Upstream checks (tools/check.sh web)"
PATH="$shim:$PATH" bash tools/check.sh web
echo "== Build (generic)"
python vidaa/build.py --generic

# The site must carry nothing of this PC: the settings that identify a person or a place stay empty.
python - <<'PY'
import json, sys
text = open('out/vidaa/config.js', encoding='utf-8').read()
cfg = json.loads(text.split('window.CONFIG = ', 1)[1].rstrip().rstrip(';'))
full = [k for k in ('tmdbKey', 'latitude', 'longitude', 'city') if str(cfg.get(k, '')).strip()]
if full:
    sys.exit('out/vidaa/config.js is not generic: %s is set.' % ', '.join(full))
if not cfg.get('buildVersion'):
    sys.exit('out/vidaa/config.js has no buildVersion.')
PY
want="$(build_of out/vidaa/config.js)"

echo "== Publish $want"
clone_pages
cd "$work/site"
wipe
cp -a "$ROOT/out/vidaa/." .
git add -A
git commit -q -m "Publish $want"
count="$(git show --stat --format= HEAD | tail -1)"
if [ -n "$dry" ]; then
  echo "Dry run: would push $want to $BRANCH ($count)."
  exit 0
fi
git push -q origin "$BRANCH"
echo "Pushed $want."
wait_site "$want"
