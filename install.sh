#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
APP_HOME="${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}"

if ! command -v herdr-app >/dev/null 2>&1; then
  echo "Install Herdr and make herdr-app available on PATH first." >&2
  exit 1
fi

# Validate both mods before changing the existing installation.
for name in github issue-agent; do
  herdr-app check "$ROOT/mods/$name"
done

mkdir -p "$APP_HOME/mods" "$APP_HOME/mod-backups"
backup=""
for name in github issue-agent; do
  source="$ROOT/mods/$name"
  destination="$APP_HOME/mods/$name"
  if [[ -L "$destination" && "$(readlink -- "$destination")" == "$source" ]]; then
    echo "$name is already linked."
    continue
  fi
  if [[ -e "$destination" || -L "$destination" ]]; then
    if [[ -z "$backup" ]]; then
      backup="$(mktemp -d "$APP_HOME/mod-backups/github-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
    fi
    mv -- "$destination" "$backup/$name"
  fi
  ln -s -- "$source" "$destination"
  echo "Linked $destination -> $source"
done

if [[ -n "$backup" ]]; then
  echo "Previous mods were preserved in: $backup"
fi
echo "Installed. Keep this checkout: Herdr uses it directly."
echo "Reopen the GitHub panel; restart Herdr if it hasn't noticed the new links."
