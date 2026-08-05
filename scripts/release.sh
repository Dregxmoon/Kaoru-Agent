#!/usr/bin/env bash
#
# release.sh — flujo de release local: bump semver, tag vX.Y.Z, push.
#
# Uso:
#   bash scripts/release.sh patch    # 1.0.0 → 1.0.1
#   bash scripts/release.sh minor    # 1.0.1 → 1.1.0
#   bash scripts/release.sh major    # 1.1.0 → 2.0.0
#
# El push del tag dispara el job `release` del CI (GitHub Actions), que
# empaqueta el .exe portable y crea la GitHub Release con las notas.
set -eu

cd "$(dirname "$0")/.."

LEVEL="${1:-patch}"
case "$LEVEL" in
  patch|minor|major) ;;
  *) echo "Uso: bash scripts/release.sh [patch|minor|major]"; exit 1 ;;
esac

CURRENT="$(node -p "require('./package.json').version")"

# La version actual de package.json es la única fuente de verdad (el CI lee
# el tag). bump solo la 'version' del package.json; el lockfile se sincroniza.
NEW="$(node -e "
  const [maj, min, pat] = process.argv[1].split('.').map(Number);
  const levels = { patch: [maj, min, pat + 1], minor: [maj, min + 1, 0], major: [maj + 1, 0, 0] };
  console.log(levels[process.argv[2]].join('.'));
" "$CURRENT" "$LEVEL")"

echo "📦 $CURRENT → $NEW"

if git tag -l "v$NEW" | grep -q .; then
  echo "El tag v$NEW ya existe — no se puede publicar la misma versión."
  exit 1
fi

if ! git diff --quiet --cached; then
  echo "⚠  Hay cambios en el índice (staged) sin commitear. Se incluirán en el commit de release."
fi
if ! git diff --quiet; then
  echo "⚠  Hay cambios sin stagear. Se incluirán en el commit de release."
fi

node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
  pkg.version = '$NEW';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

git add package.json
git commit -m "release: v$NEW"

git tag "v$NEW"
git push origin "$(git branch --show-current)"
git push origin "v$NEW"

echo "✅ Release v$NEW publicada — el CI generará la GitHub Release con el .exe."
