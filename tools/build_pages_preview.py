#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Monta un cartafol 'dist_pages_preview/' listo para 'wrangler pages deploy':
frontend/ (html, css, js, pages/, assets/) + data/exports/ (os JSON xa
exportados). NON inclúe data/db/coplas.sqlite nin data/canonical: a vista
previa é só de lectura, coma se abriras o sitio local (tools/local_server.py)
pero sen backend por detrás -- crear, editar ou borrar non vai funcionar
dende esta URL ata que haxa un backend real detrás (VPS ou Workers+D1)."""
import shutil
import sys
from pathlib import Path

ROOT = Path(".")
DIST = ROOT / "dist_pages_preview"

if DIST.exists():
    shutil.rmtree(DIST)
DIST.mkdir()


def copy_tree(src: Path, dst: Path):
    shutil.copytree(
        src, dst,
        ignore=shutil.ignore_patterns(".DS_Store", "__pycache__"),
    )


# frontend/ completo (html, css, js, pages/, assets/) -> raíz do dist
for item in (ROOT / "frontend").iterdir():
    if item.name == ".DS_Store":
        continue
    if item.is_dir():
        copy_tree(item, DIST / item.name)
    else:
        shutil.copy2(item, DIST / item.name)

# data/exports/ -> dist/data/exports/ (as rutas relativas do frontend
# esperan "./data/exports/..." cando se serve dende a raíz, non dende /frontend/)
copy_tree(ROOT / "data" / "exports", DIST / "data" / "exports")

total_files = sum(1 for _ in DIST.rglob("*") if _.is_file())
size_mb = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file()) / (1024 * 1024)
print(f"OK: {DIST} listo ({total_files} ficheiros, {size_mb:.1f} MB).")
print("Non inclúe data/db/coplas.sqlite nin data/canonical -- é só lectura.")
