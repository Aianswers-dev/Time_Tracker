"""Preview and checks for the elevation data (no inputs besides public/data).

    python3 tools/data/elevation_preview.py [--out DIR]

Writes PNGs to DIR (default: bbs-elevation-preview in the system temp dir):
  map.png       hillshaded terrain, roads coloured by height, bridges with a
                white casing, tunnels dark with a magenta core
  cbd.png       the same for the CBD, South Bank and Kangaroo Point
  corridor.png  the South East / Eastern Busway corridor to Buranda and UQ
  profiles.png  height profiles of M1, M2 and 222 against the ground
and prints:
  * a spot-check table of named structures and places,
  * a walk along M1, M2 and 222 (both directions): max grade, every level
    change of more than 3 m, and any jump between consecutive vertices,
  * an audit of every grade-separated crossing in the output geometry on the
    busway / motorway corridors and in the CBD and South Bank: tunnels must
    pass under what they cross and decks over it, with the clearance found.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile

import numpy as np
import shapely
from PIL import Image, ImageDraw

import build_terrain
from common import OUT

# Height colours (m AHD): deep tunnel -> sea level -> hills.
STOPS = [(-50, (40, 0, 60)), (-10, (110, 0, 150)), (0, (30, 60, 200)), (8, (0, 170, 200)), (16, (40, 190, 80)),
         (25, (220, 210, 40)), (35, (240, 130, 20)), (50, (210, 30, 30)), (80, (255, 255, 255))]
CLR_MIN = 5.3  # report crossings with less clearance than this (m; 5.5 required, less quantisation)
CORRIDOR_BOX = (-1500.0, -2300.0, 1700.0, 1100.0)  # CBD, South Bank, Kangaroo Point
PRIORITY_ROUTES = ("M1", "M2", "222")


def colour(z: float) -> tuple[int, int, int]:
    if z <= STOPS[0][0]:
        return STOPS[0][1]
    for (z0, c0), (z1, c1) in zip(STOPS, STOPS[1:]):
        if z <= z1:
            t = (z - z0) / (z1 - z0)
            return tuple(int(a + (b - a) * t) for a, b in zip(c0, c1))
    return STOPS[-1][1]


def hillshade(h: np.ndarray, cell: float, water: float) -> np.ndarray:
    gy, gx = np.gradient(h.astype(np.float64), cell)
    # light from the north-west, 45 degrees up (rows run south -> north)
    nx, ny, nz = -gx, -gy, np.ones_like(h)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    lx, ly, lz = -0.5, 0.5, 0.7071
    shade = np.clip((nx * lx + ny * ly + nz * lz) / norm, 0, 1)
    base = np.clip((h - 0) / 80.0, 0, 1)
    rgb = np.stack([200 + 40 * base, 200 + 30 * base, 185 + 20 * base], -1) * (0.45 + 0.55 * shade)[..., None]
    wet = h < water
    rgb[wet] = np.array([150, 185, 225]) * (0.85 + 0.15 * shade[wet])[:, None]
    return np.clip(rgb[::-1], 0, 255).astype(np.uint8)  # image rows run north -> south


class Data:
    def __init__(self):
        self.inner, self.outer, self.head = build_terrain.read_terrain()
        self.ground = build_terrain.ground_sampler(self.inner, self.outer)
        with open(os.path.join(OUT, "roads.json")) as f:
            r = json.load(f)
        with open(os.path.join(OUT, "routes.json")) as f:
            self.routes = json.load(f)
        self.names = r["names"]
        self.roads = r["roads"]
        self.rail = r["rail"]
        self.rp = [np.asarray(x["p"], dtype=np.float64).reshape(-1, 2) * 0.1 for x in self.roads]
        self.rz = [np.asarray(x["z"], dtype=np.float64) * 0.1 for x in self.roads]
        # flat segment arrays
        a, b, za, zb, rid = [], [], [], [], []
        for k, (p, z) in enumerate(zip(self.rp, self.rz)):
            a.append(p[:-1])
            b.append(p[1:])
            za.append(z[:-1])
            zb.append(z[1:])
            rid.append(np.full(len(p) - 1, k))
        self.sa, self.sb = np.concatenate(a), np.concatenate(b)
        self.sza, self.szb = np.concatenate(za), np.concatenate(zb)
        self.srid = np.concatenate(rid)
        self.segs = shapely.linestrings(np.stack([self.sa, self.sb], 1))
        self.tree = shapely.STRtree(self.segs)

    def name(self, k: int) -> str:
        r = self.roads[k]
        return self.names[r["n"]] if "n" in r else ""

    def label(self, k: int) -> str:
        r = self.roads[k]
        s = self.name(k) or f"unnamed kind {r['k']}"
        if r.get("b"):
            s += " [bridge]"
        if r.get("t"):
            s += " [tunnel]"
        return s

    def road_at(self, x: float, y: float, z: float | None = None, radius: float = 25.0):
        """(road index, height there, distance) of the nearest road segment (closest in height if z given)."""
        idx = self.tree.query(shapely.points(x, y), predicate="dwithin", distance=radius)
        if not len(idx):
            return None
        p = np.array([x, y])
        a, b = self.sa[idx], self.sb[idx]
        d = b - a
        l2 = np.maximum((d * d).sum(1), 1e-9)
        t = np.clip(((p - a) * d).sum(1) / l2, 0, 1)
        dist = np.hypot(*(a + d * t[:, None] - p).T)
        zz = self.sza[idx] + (self.szb[idx] - self.sza[idx]) * t
        cost = dist + (np.abs(zz - z) * 3 if z is not None else 0)
        k = int(np.argmin(cost))
        return int(self.srid[idx[k]]), float(zz[k]), float(dist[k])


# ---------------------------------------------------------------------------
# Images


def draw_map(D: Data, path: str, box=None, px_per_m: float = 0.2, routes=()):
    g = D.inner
    if box is None:
        box = (g.x0, g.y0, g.x0 + (g.nx - 1) * g.cell, g.y0 + (g.ny - 1) * g.cell)
    x0, y0, x1, y1 = box
    W, H = int((x1 - x0) * px_per_m), int((y1 - y0) * px_per_m)
    gx1, gy1 = g.x0 + (g.nx - 1) * g.cell, g.y0 + (g.ny - 1) * g.cell
    sub = g.crop(max(x0 - 20, g.x0), max(y0 - 20, g.y0), min(x1 + 20, gx1), min(y1 + 20, gy1))
    shade = Image.fromarray(hillshade(sub.h, sub.cell, D.head["waterLevel"]))
    # place the cropped grid in the output frame
    sx0, sy1 = sub.x0, sub.y0 + (sub.ny - 1) * sub.cell
    scale = sub.cell * px_per_m
    shade = shade.resize((max(1, int(sub.nx * scale)), max(1, int(sub.ny * scale))), Image.BILINEAR)
    img = Image.new("RGB", (W, H), (255, 255, 255))
    img.paste(shade, (int((sx0 - x0) * px_per_m), int((y1 - sy1) * px_per_m)))
    d = ImageDraw.Draw(img)

    def P(p):
        return [((x - x0) * px_per_m, (y1 - y) * px_per_m) for x, y in p]

    lw = max(1, int(round(px_per_m * 6)))
    order = sorted(range(len(D.roads)), key=lambda k: (bool(D.roads[k].get("b")), float(D.rz[k].mean())))
    for k in order:
        r, p, z = D.roads[k], D.rp[k], D.rz[k]
        if not ((p[:, 0] > x0) & (p[:, 0] < x1) & (p[:, 1] > y0) & (p[:, 1] < y1)).any():
            continue
        w = lw + (1 if r["k"] in (0, 1, 7) else 0)
        pts = P(p)
        if r.get("b"):
            d.line(pts, fill=(255, 255, 255), width=w + 4)
        if r.get("t"):
            d.line(pts, fill=(30, 0, 40), width=w + 3)
        for i in range(len(p) - 1):
            c = colour(0.5 * (z[i] + z[i + 1]))
            d.line(pts[i : i + 2], fill=c, width=w if not r.get("t") else max(1, w - 1))
        if r.get("t"):
            d.line(pts, fill=(255, 0, 220), width=1)
    for rt in routes:
        p = np.asarray(rt["p"], float).reshape(-1, 2) * 0.1
        d.line(P(p), fill=(0, 0, 0), width=1)
    # legend
    for i, zz in enumerate(range(-40, 81, 5)):
        d.rectangle([10 + i * 22, H - 30, 32 + i * 22, H - 16], fill=colour(zz))
        if zz % 20 == 0:
            d.text((10 + i * 22, H - 14), f"{zz}", fill=(0, 0, 0))
    d.text((10, H - 44), "road height m AHD; white casing = bridge, dark/magenta = tunnel", fill=(0, 0, 0))
    img.save(path)


def draw_profiles(D: Data, path: str, routes):
    W, Hh = 1600, 260
    img = Image.new("RGB", (W, Hh * len(routes)), (255, 255, 255))
    d = ImageDraw.Draw(img)
    for i, rt in enumerate(routes):
        p = np.asarray(rt["p"], float).reshape(-1, 2) * 0.1
        z = np.asarray(rt["z"], float) * 0.1
        s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
        dense_s = np.linspace(0, s[-1], 1500)
        dx = np.interp(dense_s, s, p[:, 0])
        dy = np.interp(dense_s, s, p[:, 1])
        gz = D.ground(dx, dy)
        lo, hi = min(-15.0, float(z.min()) - 2), max(45.0, float(z.max()) + 2)
        oy = i * Hh

        def Y(v):
            return oy + 20 + (hi - v) / (hi - lo) * (Hh - 40)

        def X(v):
            return 40 + v / s[-1] * (W - 60)

        for zz in range(int(math.ceil(lo / 10)) * 10, int(hi) + 1, 10):
            d.line([(40, Y(zz)), (W - 20, Y(zz))], fill=(225, 225, 225))
            d.text((5, Y(zz) - 6), f"{zz}", fill=(120, 120, 120))
        d.line(list(zip(X(dense_s), Y(gz))), fill=(150, 120, 80), width=2)
        d.line(list(zip(X(s), Y(z))), fill=(220, 0, 80), width=2)
        d.text((45, oy + 4), f"{rt['id']} dir {rt['dir']} to {rt['headsign']}: route z (red) vs ground (brown), {s[-1] / 1000:.1f} km", fill=(0, 0, 0))
    img.save(path)


# ---------------------------------------------------------------------------
# Tables


def spot_checks(D: Data):
    rows = []

    def best(pred, key, sign=1):
        """Highest (sign 1) or lowest (sign -1) vertex over the roads matching pred."""
        cand = [(float(z.max()) if sign > 0 else float(-z.min()), k) for k, z in enumerate(D.rz) if pred(k)]
        if not cand:
            return None
        _, k = max(cand)
        z = D.rz[k]
        i = int(np.argmax(z) if sign > 0 else np.argmin(z))
        return k, D.rp[k][i], float(z[i])

    def at_point(pred, pt):
        """Height of the matching road closest to pt (deck over mid-river)."""
        best_ = None
        for k in range(len(D.roads)):
            if not pred(k):
                continue
            p, z = D.rp[k], D.rz[k]
            d = p[1:] - p[:-1]
            l2 = np.maximum((d * d).sum(1), 1e-9)
            t = np.clip(((pt - p[:-1]) * d).sum(1) / l2, 0, 1)
            q = p[:-1] + d * t[:, None]
            dist = np.hypot(*(q - pt).T)
            i = int(np.argmin(dist))
            if best_ is None or dist[i] < best_[0]:
                best_ = (dist[i], k, q[i], float(z[i] + (z[i + 1] - z[i]) * t[i]))
        return None if best_ is None else best_[1:]

    def near(pt, r):
        return lambda k: bool((np.hypot(*(D.rp[k] - pt).T) < r).any())

    def add(label, res, note=""):
        if res is None:
            rows.append((label, None, None, None, None, "not found"))
            return
        k, (x, y), z = res
        gz = float(D.ground(np.array([x]), np.array([y]))[0])
        rows.append((label, x, y, z, gz, (note + " " + D.label(k)).strip()))

    river = "river: ground is the bed, water at %.1f" % D.head["waterLevel"]
    add("Story Bridge deck, mid-river", at_point(lambda k: D.name(k) == "Bradfield Highway" and D.roads[k].get("b"), np.array([1210.0, 583.0])), river)
    add("Story Bridge highest point", best(lambda k: D.name(k) == "Bradfield Highway" and D.roads[k].get("b"), "max"))
    add("Captain Cook Bridge, mid-river", at_point(lambda k: D.roads[k].get("b") and D.roads[k]["k"] == 0 and near(np.array([570.0, -1325.0]), 150)(k), np.array([570.0, -1325.0])), river)
    add("Victoria Bridge, mid-river", at_point(lambda k: D.roads[k].get("b") and D.roads[k].get("bus") and near(np.array([-243.0, -386.0]), 150)(k), np.array([-243.0, -386.0])), river)
    add("Go Between Bridge, mid-river", at_point(lambda k: D.name(k) == "Go Between Bridge", np.array([-1120.0, -90.0])), river)
    add("William Jolly Bridge, mid-river", at_point(lambda k: D.name(k) == "William Jolly Bridge", np.array([-788.0, 31.0])), river)
    add("Eleanor Schonell Br., mid-river", at_point(lambda k: bool(D.roads[k].get("b") and D.roads[k].get("bus")), np.array([-256.0, -3212.0])), river)

    add("Clem7 lowest point", best(lambda k: "Clem Jones" in D.name(k), "min", -1))
    add("Legacy Way lowest point", best(lambda k: "Legacy Way" in D.name(k), "min", -1))
    add("Airport Link lowest point", best(lambda k: "Airport Link" in D.name(k), "min", -1))
    stops = D.routes["stops"]
    for label, key in (("Cultural Centre station", "Cultural Centre station, platform 1"), ("Mater Hill station", "Mater Hill station, platform 1"),
                       ("Woolloongabba station", "Woolloongabba station, platform 1"), ("Buranda busway", "Buranda busway, platform 3"),
                       ("King George Square busway stn", "King George Square, 1a"), ("Queen Street bus station", "Queen Street station, 1a"),
                       ("Roma Street busway", "Roma Street busway, platform 1"), ("South Bank busway", "South Bank busway station, platform 4"),
                       ("RBWH station", "RBWH station, platform 1")):
        st = next((s for s in stops if s["n"] == key), None)
        if st is None:
            rows.append((label, None, None, None, None, "stop not found"))
            continue
        x, y = st["x"] * 0.1, st["y"] * 0.1
        z = st.get("z", 0) * 0.1
        hit = D.road_at(x, y, z)
        gz = float(D.ground(np.array([x]), np.array([y]))[0])
        rows.append((label, x, y, z, gz, f"stop z; road there: {D.label(hit[0]) if hit else '-'}"))
    # terrain spots
    g = D.inner
    xs, ys = g.coords()
    jj = (ys > 400) & (ys < 1000)
    ii = (xs > -500) & (xs < 300)
    sub = g.h[np.ix_(jj, ii)]
    j, i = np.unravel_index(int(np.argmax(sub)), sub.shape)
    rows.append(("Spring Hill top (ground)", float(xs[ii][i]), float(ys[jj][j]), None, float(sub.max()), "terrain"))
    rows.append(("Brisbane River level", None, None, D.head["waterLevel"], float(D.ground(np.array([1210.0]), np.array([583.0]))[0]), "water surface; ground = river bed under Story Bridge"))
    print("\nSpot checks (m AHD; 'above ground' is road z minus terrain/river bed there)")
    print(f"{'feature':32s} {'x':>7s} {'y':>7s} {'z':>7s} {'ground':>7s} {'above':>7s}  note")
    for label, x, y, z, gz, note in rows:
        f = lambda v: f"{v:7.1f}" if v is not None else "      -"
        above = (z - gz) if (z is not None and gz is not None) else None
        print(f"{label:32s} {f(x)} {f(y)} {f(z)} {f(gz)} {f(above)}  {note}")


def route_walk(D: Data, ids=PRIORITY_ROUTES):
    print("\nRoute walks: max grade (segments >= 10 m), level changes > 3 m, jumps between consecutive vertices")
    out = []
    for rt in D.routes["routes"]:
        if rt["id"] not in ids:
            continue
        out.append(rt)
        p = np.asarray(rt["p"], float).reshape(-1, 2) * 0.1
        z = np.asarray(rt["z"], float) * 0.1
        seg = np.hypot(*np.diff(p, axis=0).T)
        s = np.concatenate([[0], np.cumsum(seg)])
        dz = np.diff(z)
        gr = np.abs(dz) / np.maximum(seg, 1e-6)
        long_ = seg >= 10
        k = int(np.argmax(np.where(long_, gr, 0)))
        jumps = np.flatnonzero(np.abs(dz) > 0.5 + 0.08 * seg)
        print(f"\n{rt['id']} dir {rt['dir']} -> {rt['headsign']} ({s[-1] / 1000:.1f} km, {len(p)} vertices): "
              f"z {z.min():.1f}..{z.max():.1f} m, max grade {100 * gr[k]:.1f}% at s={s[k]:.0f} m ({p[k][0]:.0f},{p[k][1]:.0f}); "
              f"jumps > 0.5 m beyond 8% grade: {len(jumps)}")
        for j in jumps:
            print(f"    JUMP at s={s[j]:.0f} ({p[j][0]:.0f},{p[j][1]:.0f}): {z[j]:.1f} -> {z[j + 1]:.1f} m over {seg[j]:.1f} m")
        # level changes: monotone runs between turning points (0.5 m hysteresis)
        ext = [0]
        direction = 0
        for i in range(1, len(z)):
            if direction >= 0 and z[i] >= z[ext[-1]] and direction == 1:
                ext[-1] = i
            elif direction <= 0 and z[i] <= z[ext[-1]] and direction == -1:
                ext[-1] = i
            elif abs(z[i] - z[ext[-1]]) > 0.5:
                if direction == 0:
                    direction = 1 if z[i] > z[ext[-1]] else -1
                    ext.append(i)
                else:
                    direction = -direction
                    ext.append(i)
        for a, b in zip(ext[:-1], ext[1:]):
            if abs(z[b] - z[a]) <= 3.0:
                continue
            ha = D.road_at(*p[a], z[a])
            hb = D.road_at(*p[b], z[b])
            ga = float(D.ground(p[a : a + 1, 0], p[a : a + 1, 1])[0])
            gb = float(D.ground(p[b : b + 1, 0], p[b : b + 1, 1])[0])
            print(f"    {'climb  ' if z[b] > z[a] else 'descent'} {z[a]:6.1f} -> {z[b]:6.1f} m over {s[b] - s[a]:5.0f} m "
                  f"({100 * abs(z[b] - z[a]) / max(s[b] - s[a], 1):.1f}% avg), s={s[a]:.0f}..{s[b]:.0f}: "
                  f"{D.label(ha[0]) if ha else '?'} [{z[a] - ga:+.1f} vs ground] -> {D.label(hb[0]) if hb else '?'} [{z[b] - gb:+.1f}]")
    return out


def crossing_audit(D: Data):
    """Grade-separated crossings in the output geometry on the corridors."""
    corridor = np.array([bool(r.get("bus")) or r["k"] == 0 for r in D.roads])
    qa, qb = D.tree.query(D.segs, predicate="intersects")
    keep = qa < qb
    qa, qb = qa[keep], qb[keep]
    ra, rb = D.srid[qa], D.srid[qb]
    keep = ra != rb
    qa, qb, ra, rb = qa[keep], qb[keep], ra[keep], rb[keep]
    # no shared vertex (a shared vertex is a junction)
    shared = np.zeros(len(qa), bool)
    for u in (D.sa, D.sb):
        for v in (D.sa, D.sb):
            shared |= np.all(np.abs(u[qa] - v[qb]) < 0.051, axis=1)
    qa, qb, ra, rb = qa[~shared], qb[~shared], ra[~shared], rb[~shared]
    pa, pb = D.sa[qa], D.sa[qb]
    da, db = D.sb[qa] - pa, D.sb[qb] - pb
    den = da[:, 0] * db[:, 1] - da[:, 1] * db[:, 0]
    ok = np.abs(den) > 1e-9
    w = pb - pa
    ta = np.clip(np.where(ok, (w[:, 0] * db[:, 1] - w[:, 1] * db[:, 0]) / np.where(ok, den, 1), 0.5), 0, 1)
    tb = np.clip(np.where(ok, (w[:, 0] * da[:, 1] - w[:, 1] * da[:, 0]) / np.where(ok, den, 1), 0.5), 0, 1)
    za = D.sza[qa] + (D.szb[qa] - D.sza[qa]) * ta
    zb = D.szb[qb] * tb + D.sza[qb] * (1 - tb)
    xy = pa + da * ta[:, None]

    def lvl(k):
        r = D.roads[k]
        return r.get("y", 1 if r.get("b") else (-1 if r.get("t") else 0)) + 0.5 * bool(r.get("b")) - 0.5 * bool(r.get("t"))

    la = np.array([lvl(k) for k in ra])
    lb = np.array([lvl(k) for k in rb])
    graded = la != lb
    x0, y0, x1, y1 = CORRIDOR_BOX
    inbox = (xy[:, 0] > x0) & (xy[:, 0] < x1) & (xy[:, 1] > y0) & (xy[:, 1] < y1)
    sel = graded & (corridor[ra] | corridor[rb] | inbox)
    # dedupe by road pair (a way crossing another usually yields one point)
    seen = {}
    for i in np.flatnonzero(sel):
        up, lo_ = (ra[i], rb[i]) if la[i] > lb[i] else (rb[i], ra[i])
        zu, zl = (za[i], zb[i]) if la[i] > lb[i] else (zb[i], za[i])
        key = (up, lo_)
        gap = zu - zl
        if key not in seen or gap < seen[key][0]:
            seen[key] = (gap, xy[i], zu, zl)
    gaps = np.array([v[0] for v in seen.values()])
    print(f"\nCrossing audit (output geometry): {len(seen)} grade-separated crossings on busways/motorways or in the CBD/South Bank box; "
          f"upper above lower by: min {gaps.min():.1f} m, median {np.median(gaps):.1f} m; under {CLR_MIN} m: {int((gaps < CLR_MIN).sum())}, "
          f"wrong way round: {int((gaps < 0).sum())}")
    bad = sorted((v[0], k, v) for k, v in seen.items() if v[0] < CLR_MIN)
    for gap, (up, lo_), (_, p, zu, zl) in bad:
        print(f"    {gap:5.1f} m at ({p[0]:6.0f},{p[1]:6.0f}): {D.label(up)} z={zu:.1f}  over  {D.label(lo_)} z={zl:.1f}")
    # tunnel cover on busway / motorway tunnels (away from the portals)
    print("Tunnel depth below the ground on busway/motorway tunnels (each tunnel way: min and max depth along it):")
    rows = []
    for k, r in enumerate(D.roads):
        if not r.get("t") or not (r.get("bus") or r["k"] in (0, 1)):
            continue
        p, z = D.rp[k], D.rz[k]
        dep = D.ground(p[:, 0], p[:, 1]) - z
        if (p[:, 0] < x0).all() or (p[:, 0] > x1 + 3000).all():
            continue
        rows.append((D.label(k), float(dep.min()), float(dep.max()), float(z.min()), p[len(p) // 2]))
    for name, dmin, dmax, zmin, mid in sorted(rows, key=lambda r: r[0]):
        print(f"    {name:45s} depth {dmin:5.1f}..{dmax:5.1f} m  lowest z {zmin:6.1f}  near ({mid[0]:.0f},{mid[1]:.0f})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "bbs-elevation-preview"))
    ap.add_argument("--no-images", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    D = Data()
    spot_checks(D)
    pr = route_walk(D)
    crossing_audit(D)
    if not args.no_images:
        draw_map(D, os.path.join(args.out, "map.png"), px_per_m=0.2)
        draw_map(D, os.path.join(args.out, "cbd.png"), box=CORRIDOR_BOX, px_per_m=0.5, routes=[r for r in pr if r["id"] == "M1"])
        draw_map(D, os.path.join(args.out, "corridor.png"), box=(-700.0, -4300.0, 2700.0, -1500.0), px_per_m=0.45, routes=pr)
        draw_profiles(D, os.path.join(args.out, "profiles.png"), pr)
        print(f"\nimages in {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
