#!/usr/bin/env python3
"""Xera frontend/js/avatar_glyphs.js: contornos simplificados das letras (Inter 600, licenza OFL)
para os avatares «mapa». Cada letra é un polígono (con buratos) en coordenadas 0..100.

Uso: pip install fonttools brotli; python3 tools/make_avatar_glyphs.py
"""
import math
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

ROOT = Path(__file__).resolve().parents[1]
FONT = ROOT / "frontend/assets/vendor/fonts/inter-latin-600-normal.woff2"
OUT = ROOT / "frontend/js/avatar_glyphs.js"
CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789Ñ?"
TOL = 1.15  # tolerancia de simplificación (unidades de 100)
STEPS = 10


class FlatPen(BasePen):
    def __init__(self, glyphSet):
        super().__init__(glyphSet)
        self.contours, self.cur = [], []

    def _moveTo(self, p): self.cur = [p]
    def _lineTo(self, p): self.cur.append(p)

    def _curveToOne(self, p1, p2, p3):
        p0 = self._getCurrentPoint()
        for i in range(1, STEPS + 1):
            t = i / STEPS; u = 1 - t
            self.cur.append((u**3*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3*p3[0],
                             u**3*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3*p3[1]))

    def _qCurveToOne(self, p1, p2):
        p0 = self._getCurrentPoint()
        for i in range(1, STEPS + 1):
            t = i / STEPS; u = 1 - t
            self.cur.append((u*u*p0[0] + 2*u*t*p1[0] + t*t*p2[0], u*u*p0[1] + 2*u*t*p1[1] + t*t*p2[1]))

    def _closePath(self):
        if len(self.cur) > 2: self.contours.append(self.cur)
        self.cur = []

    _endPath = _closePath


def dp(points, tol):
    """Douglas-Peucker sobre un contorno pechado."""
    if len(points) < 4: return points
    def dist(p, a, b):
        dx, dy = b[0]-a[0], b[1]-a[1]
        if dx == dy == 0: return math.hypot(p[0]-a[0], p[1]-a[1])
        return abs(dy*p[0] - dx*p[1] + b[0]*a[1] - b[1]*a[0]) / math.hypot(dx, dy)
    def rec(pts):
        if len(pts) < 3: return pts
        a, b = pts[0], pts[-1]
        idx, best = 0, -1
        for i in range(1, len(pts)-1):
            d = dist(pts[i], a, b)
            if d > best: idx, best = i, d
        if best > tol: return rec(pts[:idx+1])[:-1] + rec(pts[idx:])
        return [a, b]
    # parte polo punto máis afastado do primeiro para pechar ben
    far = max(range(len(points)), key=lambda i: math.hypot(points[i][0]-points[0][0], points[i][1]-points[0][1]))
    a = rec(points[:far+1]); b = rec(points[far:] + [points[0]])
    return a[:-1] + b[:-1]


def main():
    font = TTFont(str(FONT)); gs = font.getGlyphSet(); cmap = font.getBestCmap()
    rows = []
    for ch in CHARS:
        pen = FlatPen(gs); gs[cmap[ord(ch)]].draw(pen)
        cs = pen.contours
        xs = [p[0] for c in cs for p in c]; ys = [p[1] for c in cs for p in c]
        w, h = max(xs)-min(xs), max(ys)-min(ys)
        scale = min(66 / h, 70 / w)
        cx, cy = (max(xs)+min(xs))/2, (max(ys)+min(ys))/2
        out = []
        for c in cs:
            pts = [((x-cx)*scale + 50, 50 - (y-cy)*scale) for x, y in c]
            pts = dp(pts, TOL)
            out.append(" ".join(f"{x:.1f},{y:.1f}" for x, y in pts))
        rows.append((ch, "|".join(out)))
    lines = ["// Xerado por tools/make_avatar_glyphs.py (contornos de Inter 600, licenza OFL). Non editar a man.",
             "// Cada letra: contornos separados por «|»; cada contorno, puntos «x,y» (caixa 100x100).",
             "export const AVATAR_GLYPHS = {"]
    for ch, data in rows:
        lines.append(f'  {ch!r}: "{data}",'.replace("'", '"', 2))
    lines.append("};")
    OUT.write_text("\n".join(lines) + "\n")
    print(OUT, OUT.stat().st_size, "bytes", {ch: d.count("|")+1 for ch, d in rows if d.count("|")})

main()
