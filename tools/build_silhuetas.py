#!/usr/bin/env python3
"""Xera frontend/assets/silhuetas/galiza.svg a partir das catro provincias.

É só un PLACEHOLDER: o mapa de Galiza coas catro provincias (cada unha co seu
contorno, separadas por unha liña da cor do papel). Para usar unha silueta
propia, substitúe o ficheiro .svg por outro (calquera SVG con viewBox serve;
a cor vén do CSS: `fill="currentColor"`). Non fai falla volver executar isto.

Uso: python3 tools/build_silhuetas.py
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "frontend" / "assets" / "web" / "provincias.web.geojson"
OUT = ROOT / "frontend" / "assets" / "silhuetas" / "galiza.svg"
EPS = 0.12  # tolerancia de simplificación (unidades dunha caixa de 100x100)


def polygons(geometry):
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    return []


def simplify(points, eps):
    if len(points) <= 2:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        dx, dy = points[b][0] - ax, points[b][1] - ay
        len2 = dx * dx + dy * dy
        far, idx = 0.0, -1
        for i in range(a + 1, b):
            px, py = points[i][0] - ax, points[i][1] - ay
            if len2 == 0:
                d2 = px * px + py * py
            else:
                t = max(0.0, min(1.0, (px * dx + py * dy) / len2))
                d2 = (px - t * dx) ** 2 + (py - t * dy) ** 2
            if d2 > far:
                far, idx = d2, i
        if far > eps * eps and idx > 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def main():
    data = json.loads(SRC.read_text(encoding="utf-8"))
    feats = data["features"]
    lons = [p[0] for f in feats for poly in polygons(f["geometry"]) for p in poly[0]]
    lats = [p[1] for f in feats for poly in polygons(f["geometry"]) for p in poly[0]]
    min_lon, max_lon, min_lat, max_lat = min(lons), max(lons), min(lats), max(lats)
    k = math.cos(math.radians((min_lat + max_lat) / 2))
    w, h = (max_lon - min_lon) * k, max_lat - min_lat
    scale = 100 / max(w, h)
    paths = []
    for f in sorted(feats, key=lambda f: f["properties"]["CODPROV"]):
        d = ""
        for poly in polygons(f["geometry"]):
            for ri, ring in enumerate(poly):
                pts = [((lon - min_lon) * k * scale, (max_lat - lat) * scale) for lon, lat in ring]
                pts = simplify(pts, EPS)
                if len(pts) < 4:
                    continue
                d += "M" + "L".join(f"{x:.2f} {y:.2f}" for x, y in pts) + "Z"
        name = f["properties"].get("PROVINCIA", "")
        paths.append(f'  <path id="prov-{f["properties"]["CODPROV"]}" data-nome="{name}" d="{d}"/>')
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w * scale:.2f} {h * scale:.2f}" '
        'fill="currentColor" fill-rule="evenodd" stroke-linejoin="round" '
        'style="stroke:var(--bg,#F7F7F2);stroke-width:0.7">\n'
        + "\n".join(paths)
        + "\n</svg>\n"
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(svg, encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)}: {len(svg)} bytes, {len(paths)} provincias")


if __name__ == "__main__":
    main()
