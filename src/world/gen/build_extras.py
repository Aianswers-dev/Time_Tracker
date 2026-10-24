"""World extras for the 3D city: the horizon beyond the playable map, bridge
outlines and distant landmarks. Run from the repo root:

    python3 src/world/gen/build_extras.py

Input:  tools/data/raw/Brisbane.osm.pbf (same extract as tools/data/build_osm.py)
Output: src/world/gen/extras.json  (vector data, metres, same projection)
        src/world/gen/outer.png    (40 m raster of the outer suburbs:
                                    R = building cover, G = vegetation, B = major roads)

The playable map (MapData) covers `bounds`. Everything here is either outside
it (the horizon) or extra detail inside it that the main pipeline drops
(man_made=bridge outlines, used for river bridge decks and landmark bridges).
"""

import json
import math
import os
import sys

import osmium
from PIL import Image, ImageDraw
from shapely.geometry import LineString, Polygon, box
from shapely.ops import split, unary_union
from shapely.validation import make_valid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools", "data"))
from common import RAW, bounds_xy, project  # noqa: E402

PBF = os.path.join(RAW, "Brisbane.osm.pbf")
BX0, BY0, BX1, BY1 = bounds_xy()
# Inner rectangle covered by the real map ground; must match INNER_PAD in ground.ts.
INNER_PAD = 100.0
R = (BX0 - INNER_PAD, BY0 - INNER_PAD, BX1 + INNER_PAD, BY1 + INNER_PAD)
# Horizon box.
OUTER_PAD = 12000.0
BIG = (BX0 - OUTER_PAD, BY0 - OUTER_PAD, BX1 + OUTER_PAD, BY1 + OUTER_PAD)
BIG_BOX = box(*BIG)
R_BOX = box(*R)
CELL = 40.0

WATER_TAGS = {
    ("natural", "water"), ("waterway", "riverbank"), ("landuse", "reservoir"), ("landuse", "basin"),
}
VEG_TAGS = {
    ("natural", "wood"), ("landuse", "forest"), ("natural", "scrub"), ("leisure", "nature_reserve"),
    ("leisure", "park"), ("leisure", "golf_course"), ("landuse", "grass"), ("landuse", "meadow"),
    ("natural", "grassland"), ("landuse", "recreation_ground"), ("leisure", "pitch"),
}
FOREST_TAGS = {("natural", "wood"), ("landuse", "forest"), ("natural", "scrub"), ("leisure", "nature_reserve")}
ROADS = {"motorway": 0, "motorway_link": 0, "trunk": 1, "trunk_link": 1, "primary": 2, "primary_link": 2, "secondary": 3}

LON0, LAT0 = 152.975 - 0.14, -27.515 - 0.13
LON1, LAT1 = 153.075 + 0.14, -27.425 + 0.13


def in_big(lon, lat):
    return LON0 <= lon <= LON1 and LAT0 <= lat <= LAT1


class Handler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.water = []
        self.coast = []
        self.roads = []
        self.bridges = []
        self.peaks = []
        self.towers = []
        self.buildings = []
        self.veg = []

    def node(self, n):
        t = n.tags
        if not t:
            return
        lon, lat = n.location.lon, n.location.lat
        if not in_big(lon, lat):
            return
        x, y = project(lon, lat)
        if t.get("natural") == "peak" and t.get("ele"):
            try:
                self.peaks.append({"x": round(x), "y": round(y), "e": float(t.get("ele")), "n": t.get("name", "")})
            except ValueError:
                pass
        elif t.get("man_made") in ("tower", "mast", "communications_tower") and t.get("tower:type", "").startswith("communication"):
            h = t.get("height", "")
            try:
                hv = float(h.split()[0]) if h else 0.0
            except ValueError:
                hv = 0.0
            self.towers.append({"x": round(x), "y": round(y), "h": hv, "n": t.get("name", "")})

    def way(self, w):
        t = w.tags
        if t.get("natural") == "coastline":
            try:
                pts = [project(nd.lon, nd.lat) for nd in w.nodes]
            except osmium.InvalidLocationError:
                return
            self.coast.append(pts)
            return
        hw = t.get("highway")
        if hw in ROADS and t.get("tunnel") in (None, "no"):
            try:
                ll = [(nd.lon, nd.lat) for nd in w.nodes]
            except osmium.InvalidLocationError:
                return
            if not any(in_big(lo, la) for lo, la in ll):
                return
            self.roads.append((ROADS[hw], t.get("lanes"), t.get("oneway") == "yes" or hw == "motorway", [project(lo, la) for lo, la in ll]))

    def area(self, a):
        t = a.tags
        kv = {(k, t.get(k)) for k in ("natural", "waterway", "landuse", "leisure", "man_made")}
        is_water = bool(kv & WATER_TAGS)
        is_bridge = t.get("man_made") == "bridge"
        is_building = "building" in t and t.get("building") != "no"
        is_veg = bool(kv & VEG_TAGS)
        if not (is_water or is_bridge or is_building or is_veg):
            return
        try:
            polys = []
            for outer in a.outer_rings():
                oc = [(n.lon, n.lat) for n in outer]
                if not any(in_big(lo, la) for lo, la in oc[:: max(1, len(oc) // 40)]) and len(oc) < 200:
                    continue
                holes = [[project(n.lon, n.lat) for n in inner] for inner in a.inner_rings(outer)]
                polys.append(Polygon([project(lo, la) for lo, la in oc], holes))
        except osmium.InvalidLocationError:
            return
        if not polys:
            return
        if is_bridge:
            for p in polys:
                c = p.centroid
                if R[0] - 200 < c.x < R[2] + 200 and R[1] - 200 < c.y < R[3] + 200:
                    self.bridges.append((t.get("name", ""), t.get("bridge:structure", ""), t.get("layer", "0"), p))
            return
        if is_water and t.get("leisure") != "swimming_pool":
            self.water.extend(polys)
        elif is_building:
            self.buildings.extend(polys)
        elif is_veg:
            forest = bool(kv & FOREST_TAGS)
            for p in polys:
                self.veg.append((forest, p))


def ring(coords, nd=0):
    out = []
    for x, y in coords:
        out.append(round(x, nd) if nd else int(round(x)))
        out.append(round(y, nd) if nd else int(round(y)))
    return out


def polys_of(g):
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]


def sea_polygons(coast):
    """Water side of the coastline inside BIG (OSM: land on the left of a coastline way)."""
    if not coast:
        return []
    lines = [LineString(c) for c in coast if len(c) >= 2]
    merged = unary_union(lines).intersection(BIG_BOX)
    if merged.is_empty:
        return []
    pieces = split(BIG_BOX, merged)
    sea = []
    for piece in getattr(pieces, "geoms", [pieces]):
        if not isinstance(piece, Polygon) or piece.area < 1e4:
            continue
        # Classify by the nearest coastline segment: water lies to its right.
        pt = piece.representative_point()
        best = None
        for c in coast:
            for i in range(len(c) - 1):
                ax, ay = c[i]
                bx, by = c[i + 1]
                dx, dy = bx - ax, by - ay
                l2 = dx * dx + dy * dy or 1e-9
                u = max(0.0, min(1.0, ((pt.x - ax) * dx + (pt.y - ay) * dy) / l2))
                px, py = ax + dx * u, ay + dy * u
                d = math.hypot(pt.x - px, pt.y - py)
                if best is None or d < best[0]:
                    best = (d, dx * (pt.y - ay) - dy * (pt.x - ax))
        if best and best[1] < 0:
            sea.append(piece)
    return sea


def main():
    h = Handler()
    print("reading", PBF, file=sys.stderr)
    h.apply_file(PBF, locations=True, idx="flex_mem")
    print(f"water {len(h.water)} coast {len(h.coast)} roads {len(h.roads)} bridges {len(h.bridges)} buildings {len(h.buildings)} veg {len(h.veg)}", file=sys.stderr)

    water_polys = []
    for p in h.water:
        if not p.is_valid:
            p = make_valid(p)
        g = p.intersection(BIG_BOX)
        water_polys.extend(q for q in polys_of(g) if q.area > 1500 or q.intersects(R_BOX))
    water_polys.extend(sea_polygons(h.coast))
    water = unary_union(water_polys).buffer(0)
    print("water union done", file=sys.stderr)

    outer_land = BIG_BOX.difference(R_BOX).difference(water).simplify(3.0, preserve_topology=True)
    shrunk = box(R[0] + 20, R[1] + 20, R[2] - 20, R[3] - 20)
    outer_water = water.difference(shrunk).intersection(BIG_BOX).simplify(3.0, preserve_topology=True)

    def polys_json(g, min_area):
        out = []
        for p in polys_of(g):
            if p.area < min_area:
                continue
            e = {"p": ring(p.exterior.coords[:-1])}
            hs = [ring(r.coords[:-1]) for r in p.interiors if Polygon(r).area > 400]
            if hs:
                e["h"] = hs
            out.append(e)
        return out

    land_json = polys_json(outer_land, 2000)
    water_json = polys_json(outer_water, 2000)

    roads = []
    for kind, lanes, oneway, pts in h.roads:
        g = LineString(pts).intersection(BIG_BOX).difference(box(BX0 - 120, BY0 - 120, BX1 + 120, BY1 + 120))
        for part in getattr(g, "geoms", [g]):
            if not isinstance(part, LineString) or part.length < 30:
                continue
            try:
                ln = int(float(lanes)) if lanes else (3 if kind == 0 else 2)
            except ValueError:
                ln = 2
            if not oneway and not lanes:
                ln = 4 if kind <= 2 else 2
            width = max(6.0, min(30.0, ln * 3.4 + 1.0))
            roads.append({"k": kind, "w": round(width, 1), "p": ring(part.simplify(4.0).coords)})

    bridges = []
    for name, structure, layer, p in h.bridges:
        if not p.is_valid:
            p = make_valid(p)
        for q in polys_of(p):
            if q.area < 30:
                continue
            q = q.simplify(0.3, preserve_topology=True)
            e = {"p": ring(q.exterior.coords[:-1], 1)}
            if name:
                e["n"] = name
            if structure:
                e["s"] = structure
            try:
                e["l"] = int(float(layer))
            except ValueError:
                pass
            bridges.append(e)

    # Raster of the outer suburbs, rendered at 10 m and box-filtered to 40 m.
    W = int(math.ceil((BIG[2] - BIG[0]) / CELL))
    H = int(math.ceil((BIG[3] - BIG[1]) / CELL))
    SS = 4
    def px(x, y):
        return ((x - BIG[0]) / CELL * SS, (BIG[3] - y) / CELL * SS)
    layers = []
    for which in ("bld", "veg", "road"):
        im = Image.new("L", (W * SS, H * SS), 0)
        d = ImageDraw.Draw(im)
        if which == "bld":
            for p in h.buildings:
                c = p.exterior.coords
                if len(c) >= 3:
                    d.polygon([px(x, y) for x, y in c], fill=255)
        elif which == "veg":
            for forest, p in h.veg:
                c = p.exterior.coords
                if len(c) >= 3:
                    d.polygon([px(x, y) for x, y in c], fill=255 if forest else 150)
        else:
            for kind, _l, _o, pts in h.roads:
                wpx = max(1, int(round((14 if kind == 0 else 9) / CELL * SS)))
                d.line([px(x, y) for x, y in pts], fill=255, width=wpx)
        layers.append(im.resize((W, H), Image.BOX))
    # Clear the inner map (it has real geometry) with a soft edge.
    alpha = Image.new("L", (W, H), 255)
    ad = ImageDraw.Draw(alpha)
    ix0, iy0 = (BX0 - BIG[0]) / CELL, (BIG[3] - BY1) / CELL
    ix1, iy1 = (BX1 - BIG[0]) / CELL, (BIG[3] - BY0) / CELL
    ad.rectangle([ix0 - 1, iy0 - 1, ix1 + 1, iy1 + 1], fill=0)
    rgb = Image.merge("RGBA", (*layers, alpha))
    rgb.save(os.path.join(HERE, "outer.png"), optimize=True)

    out = {
        "bounds": [round(v, 1) for v in (BX0, BY0, BX1, BY1)],
        "inner": [round(v, 1) for v in R],
        "big": [round(v, 1) for v in BIG],
        "raster": {"x0": round(BIG[0], 1), "y1": round(BIG[3], 1), "cell": CELL, "w": W, "h": H},
        "land": land_json,
        "water": water_json,
        "roads": roads,
        "bridges": bridges,
        "peaks": h.peaks,
        "towers": [t for t in h.towers if t["h"] >= 100 or t["n"]],
    }
    with open(os.path.join(HERE, "extras.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("extras.json", os.path.getsize(os.path.join(HERE, "extras.json")) // 1024, "KB",
          "outer.png", os.path.getsize(os.path.join(HERE, "outer.png")) // 1024, "KB",
          f"land {len(land_json)} water {len(water_json)} roads {len(roads)} bridges {len(bridges)}", file=sys.stderr)


if __name__ == "__main__":
    main()
