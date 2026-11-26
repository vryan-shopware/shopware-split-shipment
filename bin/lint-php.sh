#!/bin/sh
# Syntax-check every tracked PHP file on the Shopware Build host (no PHP on the Mac).
#   bin/lint-php.sh [ssh-alias]   default: $SHOPWARE_BUILD_SSH_HOST
# Exits 0 when every file passes; otherwise prints the errors and exits 1.
host="${1:-$SHOPWARE_BUILD_SSH_HOST}"
[ -n "$host" ] || { echo "usage: bin/lint-php.sh <ssh-alias> (or set SHOPWARE_BUILD_SSH_HOST)" >&2; exit 2; }
cd "$(dirname "$0")/.." || exit 2
git ls-files -z '*.php' | COPYFILE_DISABLE=1 xargs -0 tar --no-xattrs -cf - | ssh -o BatchMode=yes "$host" '
  d=$(mktemp -d) && tar xf - -C "$d" 2>/dev/null &&
  out=$(find "$d" -name "*.php" -print0 | xargs -0 -n1 php -l 2>&1 | grep -v "^No syntax errors"); rm -rf "$d"
  [ -z "$out" ] && echo "PHP syntax OK" || { echo "$out"; exit 1; }'
