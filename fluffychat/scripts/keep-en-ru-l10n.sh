#!/usr/bin/env bash
# Keep only the UI languages Plotina maintains. FluffyChat ships translations
# for every language upstream supports, but our builds are en/ru only: remove
# the rest before Flutter generates l10n.dart and l10n_<locale>.dart.
#
# Usage: scripts/keep-en-ru-l10n.sh [upstream-dir] (default: upstream)
set -euo pipefail

root="${1:-upstream}"
l10n="$root/lib/l10n"

[ -d "$l10n" ] || { echo "not a FluffyChat tree: $root" >&2; exit 1; }

for file in "$l10n"/intl_*.arb; do
  case "$(basename "$file")" in
    intl_en.arb|intl_ru.arb) ;;
    *) rm -f "$file" ;;
  esac
done

for file in "$l10n"/l10n_*.dart; do
  case "$(basename "$file")" in
    l10n_en.dart|l10n_ru.dart) ;;
    *) rm -f "$file" ;;
  esac
done

# Flutter regenerates this from the remaining ARB files. Removing it prevents a
# stale generated file from importing locales that are no longer in the tree.
rm -f "$l10n/l10n.dart"
