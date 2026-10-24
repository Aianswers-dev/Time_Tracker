"""Extract the Brisbane inner-city map from the BBBike OSM extract.

Input:  tools/data/raw/Brisbane.osm.pbf, the terrain tiles (build_terrain.py)
Output: public/data/roads.json, buildings.json, areas.json, terrain.bin,
        terrain.json

All coordinates are decimetre integers in world space (see common.py), stored
as flat [x0, y0, x1, y1, ...] arrays. Roads and rail are collected at full
resolution with their OSM node ids; elevation.build() solves their heights
(adding the per-vertex "z" arrays, decimetres AHD) before they are clipped to
the map and simplified, and writes the terrain.
"""

import json
import os
import re
import sys

import osmium
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
from shapely.validation import make_valid

import elevation
from common import OUT, RAW, bounds_xy, in_bbox, project, q

PBF = os.path.join(RAW, "Brisbane.osm.pbf")

BX0, BY0, BX1, BY1 = bounds_xy()
CLIP = box(BX0, BY0, BX1, BY1)
CLIP_PAD = box(BX0 - 150, BY0 - 150, BX1 + 150, BY1 + 150)

ROAD_KIND = {
    "motorway": 0, "motorway_link": 0,
    "trunk": 1, "trunk_link": 1,
    "primary": 2, "primary_link": 2,
    "secondary": 3, "secondary_link": 3,
    "tertiary": 4, "tertiary_link": 4,
    "unclassified": 5, "residential": 5, "living_street": 5, "road": 5,
    "service": 6,
    "busway": 7, "bus_guideway": 7,
    "pedestrian": 8,
}
DEFAULT_LANES = {0: 3, 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 1, 7: 2, 8: 1}
LANE_W = {0: 3.5, 1: 3.4, 2: 3.3, 3: 3.3, 4: 3.2, 5: 3.0, 6: 3.0, 7: 3.5, 8: 3.0}

AREA_KIND = {
    # 0 water, 1 park/grass, 2 wood, 3 pitch/sport, 4 cemetery, 5 plaza, 6 sand
    ("natural", "water"): 0, ("waterway", "riverbank"): 0, ("landuse", "reservoir"): 0,
    ("landuse", "basin"): 0, ("leisure", "swimming_pool"): 0,
    ("leisure", "park"): 1, ("leisure", "garden"): 1, ("landuse", "grass"): 1,
    ("landuse", "recreation_ground"): 1, ("leisure", "recreation_ground"): 1,
    ("landuse", "village_green"): 1, ("landuse", "meadow"): 1, ("natural", "grassland"): 1,
    ("leisure", "golf_course"): 1, ("leisure", "nature_reserve"): 2,
    ("natural", "wood"): 2, ("landuse", "forest"): 2, ("natural", "scrub"): 2,
    ("leisure", "pitch"): 3, ("leisure", "track"): 3, ("leisure", "stadium"): 3,
    ("landuse", "cemetery"): 4, ("amenity", "grave_yard"): 4,
    ("place", "square"): 5, ("highway", "pedestrian"): 5, ("area:highway", "pedestrian"): 5,
    ("natural", "beach"): 6, ("natural", "sand"): 6,
}

BUILDING_KIND = {
    "house": 1, "detached": 1, "semidetached_house": 1, "bungalow": 1, "terrace": 1,
    "residential": 1, "hut": 1, "shed": 6, "garage": 6, "garages": 6, "carport": 6,
    "apartments": 2, "dormitory": 2, "hotel": 2,
    "commercial": 3, "office": 3, "retail": 3, "supermarket": 3, "industrial": 4,
    "warehouse": 4, "church": 5, "cathedral": 5, "chapel": 5, "civic": 5,
    "government": 5, "public": 5, "school": 5, "university": 5, "hospital": 5,
    "train_station": 5, "transportation": 5, "stadium": 5, "grandstand": 5,
    "museum": 5, "parking": 7, "roof": 8,
}

# Corrections to OSM tags, by way id, applied before anything else reads the
# tags (keys set to None are removed). Use this when a bridge, tunnel or
# layer tag on a busway/motorway corridor is wrong or missing and the height
# solve therefore puts a structure at the wrong level; give the reason. The
# busway corridors (M1, M2, 222) and the motorways were audited with
# elevation_preview.py and needed none; mis-shared nodes where a street
# passes through a tunnel or bridge are handled generally by
# elevation._split_nodes().
TAG_OVERRIDES: dict[int, dict[str, str | None]] = {
    # 123456789: {"tunnel": "yes", "layer": "-2"},  # example: reason
}

NUM = re.compile(r"[-+]?\d*\.?\d+")


def num(v: str | None) -> float | None:
    if not v:
        return None
    m = NUM.search(v.replace(",", "."))
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def is_bus_platform(tags) -> bool:
    """Bus platforms and their shelters; excludes railway platforms."""
    if tags.get("public_transport") != "platform" and tags.get("highway") != "platform":
        return False
    if tags.get("railway") == "platform" or tags.get("train") == "yes" or tags.get("tram") == "yes":
        return False
    if tags.get("ferry") == "yes" or tags.get("amenity") == "ferry_terminal" or tags.get("bus") == "no":
        return False
    return True


def flat(coords) -> list[int]:
    out: list[int] = []
    for x, y in coords:
        out.append(q(x))
        out.append(q(y))
    return out


def simplify_ring(coords, tol=0.3):
    poly = Polygon(coords)
    s = poly.simplify(tol, preserve_topology=True)
    if s.is_empty or not isinstance(s, Polygon):
        return list(coords)
    return list(s.exterior.coords)


class Handler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.lines: list[elevation.Line] = []  # roads and rail, full resolution
        self.buildings: list[dict] = []
        self.areas: list[dict] = []
        self.signals: list[int] = []
        self.trees: list[int] = []
        self.crossings: list[int] = []
        self.names: list[str] = []
        self.name_idx: dict[str, int] = {}
        self.water_polys: list[Polygon] = []
        self.platforms: list[dict] = []

    def name(self, n: str | None) -> int:
        if not n:
            return -1
        if n not in self.name_idx:
            self.name_idx[n] = len(self.names)
            self.names.append(n)
        return self.name_idx[n]

    # Nodes -----------------------------------------------------------------
    def node(self, n):
        if not n.tags:
            return
        loc = n.location
        if not loc.valid() or not in_bbox(loc.lon, loc.lat):
            return
        hw = n.tags.get("highway")
        if hw == "traffic_signals":
            x, y = project(loc.lon, loc.lat)
            self.signals += [q(x), q(y)]
        elif hw == "crossing" and n.tags.get("crossing") in ("traffic_signals", "zebra", "marked", "uncontrolled"):
            x, y = project(loc.lon, loc.lat)
            self.crossings += [q(x), q(y)]
        elif n.tags.get("natural") == "tree":
            x, y = project(loc.lon, loc.lat)
            self.trees += [q(x), q(y)]

    # Ways (roads, rail) ----------------------------------------------------
    def way(self, w):
        tags = w.tags
        if w.id in TAG_OVERRIDES:
            tags = {k: v for k, v in tags}
            for k, v in TAG_OVERRIDES[w.id].items():
                if v is None:
                    tags.pop(k, None)
                else:
                    tags[k] = v
        if is_bus_platform(tags) and not w.is_closed():
            try:
                pts = [(nd.lon, nd.lat) for nd in w.nodes]
            except osmium.InvalidLocationError:
                return
            if len(pts) >= 2 and any(in_bbox(lon, lat) for lon, lat in pts):
                self.add_platform(tags, [project(lon, lat) for lon, lat in pts], closed=False)
            return
        hw = tags.get("highway")
        rw = tags.get("railway")
        if hw is None and rw is None:
            return
        try:
            pts = [(nd.lon, nd.lat) for nd in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(pts) < 2 or not any(in_bbox(lon, lat, 0.002) for lon, lat in pts):
            return
        xy = [project(lon, lat) for lon, lat in pts]
        nodes = [nd.ref for nd in w.nodes]
        layer_tag = num(tags.get("layer"))

        if hw in ROAD_KIND:
            if hw == "service" and tags.get("service") in ("driveway", "parking_aisle", "drive-through", "emergency_access"):
                return
            if tags.get("area") == "yes":
                return
            kind = ROAD_KIND[hw]
            if hw == "service" and (tags.get("bus") in ("yes", "designated") or tags.get("psv") == "designated"):
                kind = 7
            lanes = num(tags.get("lanes"))
            lanes = int(lanes) if lanes and 0 < lanes < 10 else DEFAULT_LANES[kind]
            oneway = tags.get("oneway")
            ow = 0
            if oneway in ("yes", "true", "1") or tags.get("junction") in ("roundabout", "circular") or hw == "motorway":
                ow = 1
            elif oneway == "-1":
                ow = 1
                xy.reverse()
                nodes.reverse()
            if not ow and kind in (5, 6) and tags.get("lanes") is None:
                lanes = 2 if kind == 5 else 1
            width = num(tags.get("width"))
            if not width or width < 2.5 or width > 40:
                width = lanes * LANE_W[kind] + (1.0 if kind <= 4 else 0.4)
                if ow and kind in (5, 6) and tags.get("lanes") is None:
                    width = max(width, 4.5)
            bridge = 1 if tags.get("bridge") not in (None, "no") else 0
            tunnel = tags.get("tunnel")
            tun = 1 if tunnel in ("yes", "culvert", "covered") else 0
            layer = layer_tag or 0
            # "p" (and "z") are filled in by elevation.build() after the height solve
            road = {
                "k": kind,
                "w": round(width, 1),
                "l": lanes,
                "p": None,
            }
            label = tags.get("name") or tags.get("ref")
            nm = self.name(label)
            if nm >= 0:
                road["n"] = nm
            if ow:
                road["o"] = 1
            if bridge:
                road["b"] = 1
            if tun:
                road["t"] = 1
            if layer:
                road["y"] = int(layer)
            ms = num(tags.get("maxspeed"))
            if ms and 5 <= ms <= 130:
                road["ms"] = int(ms)
            if hw.endswith("_link"):
                road["lk"] = 1
            if hw == "busway" or kind == 7:
                road["bus"] = 1
            self.lines.append(
                elevation.Line(
                    id=w.id, nodes=nodes, xy=xy, kind=kind, bridge=bool(bridge),
                    # covered roads and building passages stay at grade
                    tunnel=tunnel == "yes", layer=int(layer), has_layer=layer_tag is not None,
                    link=hw.endswith("_link"), emit=True, meta=road,
                    name=tags.get("bridge:name") or label or "",
                )
            )
        elif rw in ("rail", "light_rail", "subway", "narrow_gauge") and tags.get("service") not in ("yard", "siding", "spur"):
            r = {"p": None}
            if tags.get("bridge") not in (None, "no"):
                r["b"] = 1
            if tags.get("tunnel") not in (None, "no"):
                r["t"] = 1
            self.lines.append(
                elevation.Line(
                    id=w.id, nodes=nodes, xy=xy, kind=elevation.RAIL, bridge="b" in r,
                    tunnel=tags.get("tunnel") == "yes", layer=int(layer_tag or 0), has_layer=layer_tag is not None,
                    link=False, emit=True, meta=r, name=tags.get("bridge:name") or tags.get("name") or "",
                )
            )

    # Areas (buildings, water, parks) --------------------------------------
    def area(self, a):
        tags = a.tags
        if is_bus_platform(tags):
            # Bus platforms (incl. their shelters tagged building=transportation/roof)
            # are exported separately so they are not solid buildings.
            try:
                for outer in a.outer_rings():
                    oc = [(n.lon, n.lat) for n in outer]
                    if any(in_bbox(lon, lat) for lon, lat in oc):
                        self.add_platform(tags, [project(lon, lat) for lon, lat in oc][:-1], closed=True)
            except osmium.InvalidLocationError:
                pass
            return
        is_building = "building" in tags or "building:part" in tags
        akind = None
        for (k, v), code in AREA_KIND.items():
            if tags.get(k) == v:
                akind = code
                break
        if not is_building and akind is None:
            return
        if is_building and tags.get("building") in ("no",) and "building:part" not in tags:
            return
        try:
            polys = []
            for outer in a.outer_rings():
                oc = [(n.lon, n.lat) for n in outer]
                if not any(in_bbox(lon, lat, 0.003) for lon, lat in oc[:: max(1, len(oc) // 50)]) and not (
                    akind == 0 and len(oc) > 50
                ):
                    continue
                holes = [[project(n.lon, n.lat) for n in inner] for inner in a.inner_rings(outer)]
                polys.append(Polygon([project(lon, lat) for lon, lat in oc], holes))
        except osmium.InvalidLocationError:
            return
        if not polys:
            return

        if is_building:
            for poly in polys:
                if not poly.is_valid:
                    poly = make_valid(poly)
                if not poly.intersects(CLIP):
                    continue
                for p in getattr(poly, "geoms", [poly]):
                    if not isinstance(p, Polygon) or p.area < 6:
                        continue
                    self.add_building(tags, p)
            return

        for poly in polys:
            if not poly.is_valid:
                poly = make_valid(poly)
            clipped = poly.intersection(CLIP_PAD)
            for p in getattr(clipped, "geoms", [clipped]):
                if not isinstance(p, Polygon) or p.area < 20:
                    continue
                if akind == 0 and tags.get("leisure") != "swimming_pool":
                    self.water_polys.append(p)
                    continue
                p = p.simplify(0.5, preserve_topology=True)
                if p.is_empty or not isinstance(p, Polygon):
                    continue
                entry = {"k": akind, "p": flat(p.exterior.coords[:-1])}
                if p.interiors:
                    entry["h"] = [flat(r.coords[:-1]) for r in p.interiors]
                self.areas.append(entry)

    def add_platform(self, tags, xy, closed: bool):
        if len(xy) < 2:
            return
        layer = num(tags.get("layer")) or 0
        level = num(tags.get("level"))
        under = tags.get("location") == "underground" or layer < 0 or (level is not None and level < 0)
        entry = {
            "n": tags.get("name") or "",
            "r": tags.get("ref") or tags.get("local_ref") or "",
            "p": flat(xy),
        }
        if closed:
            entry["a"] = 1
        if tags.get("covered") == "yes" or tags.get("shelter") == "yes" or "building" in tags:
            entry["cv"] = 1
        if layer:
            entry["y"] = int(layer)
        if under:
            entry["u"] = 1
        self.platforms.append(entry)

    def add_building(self, tags, p: Polygon):
        h = num(tags.get("height")) or num(tags.get("building:height"))
        levels = num(tags.get("building:levels"))
        mh = num(tags.get("min_height"))
        min_level = num(tags.get("building:min_level"))
        btype = tags.get("building") or tags.get("building:part") or "yes"
        kind = BUILDING_KIND.get(btype, 0)
        if h is None:
            if levels is not None:
                h = levels * 3.2 + (1.0 if kind != 1 else 0.6)
            else:
                h = {1: 5.5, 2: 12, 3: 9, 4: 8, 5: 11, 6: 3, 7: 9, 8: 4}.get(kind, 7.0)
        if mh is None and min_level is not None:
            mh = min_level * 3.2
        h = max(2.5, min(h, 330))
        coords = simplify_ring(list(p.exterior.coords))[:-1]
        if len(coords) < 3:
            return
        b = {"h": round(h, 1), "p": flat(coords)}
        if mh and mh < h - 0.5:
            b["m"] = round(mh, 1)
        if kind:
            b["k"] = kind
        if "building:part" in tags and "building" not in tags:
            b["pt"] = 1
        col = tags.get("building:colour") or tags.get("colour")
        if col and re.fullmatch(r"#[0-9a-fA-F]{6}", col):
            b["c"] = col.lower()
        roof = tags.get("roof:shape")
        if roof in ("gabled", "hipped", "pyramidal", "dome", "skillion"):
            b["r"] = roof[0]
        rc = tags.get("roof:colour")
        if rc and re.fullmatch(r"#[0-9a-fA-F]{6}", rc):
            b["rc"] = rc.lower()
        nm = tags.get("name")
        if nm and p.area > 1500:
            b["n"] = nm
        self.buildings.append(b)


def main():
    h = Handler()
    print("reading", PBF, file=sys.stderr)
    h.apply_file(PBF, locations=True, idx="flex_mem")

    print(f"road and rail ways {len(h.lines)} buildings {len(h.buildings)} areas {len(h.areas)} water {len(h.water_polys)}", file=sys.stderr)

    water = unary_union(h.water_polys).intersection(CLIP_PAD) if h.water_polys else None
    water_out = []
    if water is not None:
        water = water.simplify(0.8, preserve_topology=True)
        for p in getattr(water, "geoms", [water]):
            if isinstance(p, Polygon) and p.area > 50:
                entry = {"p": flat(p.exterior.coords[:-1])}
                if p.interiors:
                    entry["h"] = [flat(r.coords[:-1]) for r in p.interiors if Polygon(r).area > 20]
                water_out.append(entry)

    # Heights: terrain cleaning, the road/rail solve, terrain.bin, building bases.
    roads, rail = elevation.build(h.lines, water_out, h.buildings, h.areas, CLIP_PAD.bounds)
    print(f"roads {len(roads)} rail {len(rail)}", file=sys.stderr)
    # keep only the names of roads that survived clipping, in order of first use
    remap: dict[int, int] = {}
    names: list[str] = []
    for r in roads:
        if "n" in r:
            if r["n"] not in remap:
                remap[r["n"]] = len(names)
                names.append(h.names[r["n"]])
            r["n"] = remap[r["n"]]

    os.makedirs(OUT, exist_ok=True)
    bx0, by0, bx1, by1 = bounds_xy()
    meta = {
        "bounds": [round(bx0, 1), round(by0, 1), round(bx1, 1), round(by1, 1)],
        "scale": 0.1,
    }
    with open(os.path.join(OUT, "roads.json"), "w") as f:
        json.dump({**meta, "names": names, "roads": roads, "rail": rail, "signals": h.signals, "crossings": h.crossings}, f, separators=(",", ":"))
    with open(os.path.join(OUT, "buildings.json"), "w") as f:
        json.dump({**meta, "buildings": h.buildings}, f, separators=(",", ":"))
    with open(os.path.join(OUT, "areas.json"), "w") as f:
        json.dump({**meta, "water": water_out, "areas": h.areas, "trees": h.trees}, f, separators=(",", ":"))
    with open(os.path.join(OUT, "platforms.json"), "w") as f:
        json.dump({**meta, "platforms": h.platforms}, f, separators=(",", ":"))
    print("platforms", len(h.platforms), file=sys.stderr)
    for name in ("roads.json", "buildings.json", "areas.json"):
        print(name, os.path.getsize(os.path.join(OUT, name)) // 1024, "KB", file=sys.stderr)


if __name__ == "__main__":
    main()
