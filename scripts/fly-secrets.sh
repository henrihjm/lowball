#!/usr/bin/env bash
# Copies the non-empty values from .env to Fly secrets. Values are never printed.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo ".env not found"; exit 1; }
args=()
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
  key="${BASH_REMATCH[1]}"
  val="${BASH_REMATCH[2]}"
  val="${val%%[[:space:]]#*}"                      # strip trailing comment
  val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [[ -z "$val" || "$val" == \#* ]] && continue
  case "$key" in
    PORT|PUBLIC_BASE_URL|LOWBALL_API_URL) continue ;;   # set per environment
  esac
  args+=("$key=$val")
  echo "  $key"
done < .env
[ ${#args[@]} -gt 0 ] || { echo "nothing to set"; exit 1; }
fly secrets set --stage "${args[@]}" "$@" > /dev/null
echo "Staged ${#args[@]} secrets. They apply on the next fly deploy."
