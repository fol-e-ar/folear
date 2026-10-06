#!/usr/bin/env bash
# Copia de seguridade da produción: dump completo da D1 + exports públicos en JSON.
#
#   tools/backup.sh [cartafol_destino]     (por defecto ~/folear-backups)
#
# IMPORTANTE: o dump da D1 inclúe contas (nomes e correos), polo que debe
# gardarse FÓRA do repositorio e non compartirse. Require ter feito
# `npx wrangler login` (ou ter CLOUDFLARE_API_TOKEN) e `npm install` en infra/cloudflare.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/folear-backups}"
DAY="$(date +%F)"
OUT="$DEST/$DAY"
SITE="${FOLEAR_SITE:-https://folear.gal}"

case "$OUT" in
  "$ROOT"/*) echo "Destino dentro do repo ($OUT): elixe un cartafol fóra de $ROOT" >&2; exit 1 ;;
esac

mkdir -p "$OUT"
cd "$ROOT/infra/cloudflare"
echo "Exportando a D1 (remota)..."
npx wrangler d1 export fol-e-ar-db --remote --output "$OUT/d1-$DAY.sql"

echo "Descargando exports públicos de $SITE ..."
for path in coplas/coplas territorios/territorios media/media melodias/melodias pezas/pezas; do
  curl -fsS "$SITE/data/exports/$path.json" -o "$OUT/$(basename "$path").json"
done

echo "Comprobando a copia..."
python3 "$ROOT/tools/check_backup.py" "$OUT/d1-$DAY.sql"
echo "Feito: $OUT"
