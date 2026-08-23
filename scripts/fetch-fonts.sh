#!/usr/bin/env bash
# Fetches, instances, renames and subsets the three OFL fonts to-hoot ships.
#
# The output is committed, so this runs rarely: only to pick up an upstream
# release or to widen the character set. Nothing in the build calls it.
#
# Renaming is not cosmetic. Subsetting is a modification, and the SIL Open Font
# Licence reserves the original family name for unmodified versions, so the
# subsets ship as To-Hoot Sans / Serif / Mono. Each keeps its upstream OFL.txt
# verbatim beside it.
#
# Requires: python3 with fonttools and brotli (pip install 'fonttools[woff]').

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/packages/ui/src/fonts"
RAW="https://raw.githubusercontent.com/google/fonts/main/ofl"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

python3 -c 'import brotli, fontTools' 2>/dev/null ||
  { echo "fonttools with brotli is required: pip install 'fonttools[woff]'" >&2; exit 1; }

# The Google "latin" subset: ASCII, Latin-1, the combining marks and typographic
# punctuation real copy uses, and U+FFFD so a bad byte still renders as a box.
UNICODES='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'

# slug | upstream file | output basename | new family | axis limits
FONTS=(
  'instrumentsans|InstrumentSans[wdth,wght].ttf|tohoot-sans|To-Hoot Sans|wdth=100 wght=400:700'
  'newsreader|Newsreader[opsz,wght].ttf|tohoot-serif|To-Hoot Serif|opsz=16 wght=400:600'
  'jetbrainsmono|JetBrainsMono[wght].ttf|tohoot-mono|To-Hoot Mono|wght=400:700'
)

for spec in "${FONTS[@]}"; do
  IFS='|' read -r slug upstream base family limits <<<"$spec"
  dir="$OUT/${base#tohoot-}"
  mkdir -p "$dir"
  url_file="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$upstream")"

  echo "fetching $slug"
  curl -fsSL -o "$dir/OFL.txt" "$RAW/$slug/OFL.txt"
  curl -fsSL -o "$WORK/$base.ttf" "$RAW/$slug/$url_file"

  echo "  instancing ($limits)"
  # Word splitting on $limits is intended: each axis limit is a separate argument.
  # shellcheck disable=SC2086
  python3 -m fontTools.varLib.instancer -q -o "$WORK/$base-inst.ttf" "$WORK/$base.ttf" $limits

  echo "  renaming to \"$family\""
  python3 "$ROOT/scripts/rename-font.py" "$WORK/$base-inst.ttf" "$family"

  echo "  subsetting"
  python3 -m fontTools.subset "$WORK/$base-inst.ttf" \
    --output-file="$dir/$base.woff2" \
    --flavor=woff2 \
    --unicodes="$UNICODES" \
    --layout-features='kern,liga,calt,tnum,ccmp,locl,mark,mkmk' \
    --name-IDs='*' \
    --drop-tables+=DSIG \
    --no-hinting \
    --desubroutinize

  printf '  %s -> %s (%s)\n' "$upstream" "$base.woff2" "$(du -h "$dir/$base.woff2" | cut -f1)"
done

echo "done. Subsets and their OFL notices are in $OUT"
