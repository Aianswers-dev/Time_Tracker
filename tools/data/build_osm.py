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
import math
import os
import re
import sys

import numpy as np
import osmium
from shapely.geometry import LineString, Polygon, box
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
#
# Closed ways (buildings, platforms) are overridden the same way, by way id.
TAG_OVERRIDES: dict[int, dict[str, str | None]] = {
    # 123456789: {"tunnel": "yes", "layer": "-2"},  # example: reason
    # Bus-station outlines mapped as buildings over open-air stations: the
    # platforms carry their own canopies (satellite review #5, stations #3).
    679186732: {"building": None},  # Buranda busway station: open cutting
    679188308: {"building": None},  # Woolloongabba station: at grade, open
    44785112: {"building": None},  # RBWH station footprint (layer 2) over the open busway
    # Greenslopes station outline: its two arms are the platform canopies
    683341098: {"building": "roof", "height": "4.5"},
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


FEET = re.compile(r"(\d+)\s*'\s*(?:(\d+)\s*\")?")


def maxheight_m(v: str | None) -> float:
    """A maxheight tag in metres ("1.93", "2.1 m", "6'8\""), or 0 when absent or not a number."""
    if not v:
        return 0.0
    f = FEET.search(v)
    h = (int(f.group(1)) * 12 + int(f.group(2) or 0)) * 0.0254 if f else num(v)
    return h if h and 1.5 <= h <= 6.0 else 0.0


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
        # (OSM node id, x, y, direction: +1 forward / -1 backward along the way, 0 both)
        self.signal_nodes: list[tuple[int, float, float, int]] = []
        self.width_tagged: set[int] = set()
        self.lanes_tagged: set[int] = set()
        # every man_made=bridge outline, and the paths (footways, cycleways) on bridges: bridge_widths()
        self.bridge_decks: list[Polygon] = []
        self.bridge_paths: list[list[tuple[float, float]]] = []
        # named man_made=bridge outlines: (polygon, name), see name_bridges()
        self.bridge_outlines: list[tuple[Polygon, str]] = []
        # mapped barrier=retaining_wall lines (flat decimetres): where a road's cutting wall really stands
        self.retaining: list[list[int]] = []

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
            d = n.tags.get("traffic_signals:direction") or n.tags.get("direction")
            self.signal_nodes.append((n.id, x, y, 1 if d == "forward" else -1 if d == "backward" else 0))
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
                self.add_platform(tags, [project(lon, lat) for lon, lat in pts], closed=False, osm_id=w.id)
            return
        hw = tags.get("highway")
        rw = tags.get("railway")
        if hw in BRIDGE_PATHS and tags.get("bridge") not in (None, "no") and tags.get("area") != "yes":
            try:
                pts = [(nd.lon, nd.lat) for nd in w.nodes]
            except osmium.InvalidLocationError:
                return
            if len(pts) >= 2 and any(in_bbox(lon, lat, 0.002) for lon, lat in pts):
                self.bridge_paths.append([project(lon, lat) for lon, lat in pts])
            return
        if hw is None and rw is None and tags.get("barrier") == "retaining_wall":
            try:
                pts = [(nd.lon, nd.lat) for nd in w.nodes]
            except osmium.InvalidLocationError:
                return
            if len(pts) >= 2 and any(in_bbox(lon, lat, 0.002) for lon, lat in pts):
                self.retaining.append(flat(project(lon, lat) for lon, lat in pts))
            return
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
            if lanes and 0 < lanes < 10:
                self.lanes_tagged.add(w.id)
            lanes = int(lanes) if lanes and 0 < lanes < 10 else DEFAULT_LANES[kind]
            oneway = tags.get("oneway")
            ow = 0
            rev = False
            if oneway in ("yes", "true", "1") or tags.get("junction") in ("roundabout", "circular") or hw == "motorway":
                ow = 1
            elif oneway == "-1":
                ow = 1
                rev = True
                xy.reverse()
                nodes.reverse()
            if not ow and kind in (5, 6) and tags.get("lanes") is None:
                lanes = 2 if kind == 5 else 1
            width = num(tags.get("width"))
            if width and 2.5 <= width <= 40:
                self.width_tagged.add(w.id)
            else:
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
            # the street name only: route numbers ("22;95") are not names (61 #19);
            # on a busway bridge, the bridge's name when the way carries one (other
            # roads keep their street name: landmarks.ts finds the Story Bridge deck
            # by "Bradfield Highway")
            label = tags.get("name")
            if bridge and (hw == "busway" or kind == 7) and tags.get("bridge:name"):
                label = tags.get("bridge:name")
                road["_bn"] = 1
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
                    name=tags.get("bridge:name") or label or tags.get("ref") or "", reversed=rev,
                    maxheight=maxheight_m(tags.get("maxheight")),
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
        if tags.get("man_made") == "bridge":
            try:
                for outer in a.outer_rings():
                    xy = [project(n.lon, n.lat) for n in outer]
                    if len(xy) >= 4 and any(in_bbox(n.lon, n.lat, 0.003) for n in outer):
                        poly = Polygon(xy)
                        self.bridge_decks.append(poly if poly.is_valid else make_valid(poly))
            except osmium.InvalidLocationError:
                pass
        if tags.get("man_made") == "bridge" and tags.get("name"):
            try:
                for outer in a.outer_rings():
                    xy = [project(n.lon, n.lat) for n in outer]
                    if len(xy) >= 4 and any(in_bbox(n.lon, n.lat, 0.003) for n in outer):
                        poly = Polygon(xy)
                        self.bridge_outlines.append((poly if poly.is_valid else make_valid(poly), tags.get("name")))
            except osmium.InvalidLocationError:
                pass
        if a.from_way() and a.orig_id() in TAG_OVERRIDES:
            tags = {k: v for k, v in tags}
            for k, v in TAG_OVERRIDES[a.orig_id()].items():
                if v is None:
                    tags.pop(k, None)
                else:
                    tags[k] = v
        if is_bus_platform(tags):
            # Bus platforms (incl. their shelters tagged building=transportation/roof)
            # are exported separately so they are not solid buildings.
            try:
                for outer in a.outer_rings():
                    oc = [(n.lon, n.lat) for n in outer]
                    if any(in_bbox(lon, lat) for lon, lat in oc):
                        self.add_platform(tags, [project(lon, lat) for lon, lat in oc][:-1], closed=True,
                                          osm_id=a.orig_id() if a.from_way() else -a.orig_id())
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
                    self.add_building(tags, p, a.orig_id())
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

    def add_platform(self, tags, xy, closed: bool, osm_id: int = 0):
        """Platforms leave here raw; stations.build() turns them into slabs
        (lines become polygons, duplicates go, "u" is set from the busway
        beside them). Keys starting with "_" are dropped before writing."""
        if len(xy) < 2:
            return
        layer = num(tags.get("layer")) or 0
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
        # mapped underground: prefer a tunnel busway as the platform's road
        if tags.get("location") == "underground":
            entry["_under"] = True
        entry["_id"] = osm_id
        self.platforms.append(entry)

    def add_building(self, tags, p: Polygon, osm_id: int = 0):
        btype = tags.get("building") or tags.get("building:part") or "yes"
        # a bridge's outline (a footbridge or enclosed walkway over a road):
        # stations.bridge_bases lifts it clear of what passes under it, or
        # drops it; extruded from the street it stands in the road (the PA
        # Hospital footbridge across the busway, M2 #13)
        is_bridge = btype == "bridge" or tags.get("man_made") == "bridge"
        h = num(tags.get("height")) or num(tags.get("building:height"))
        levels = num(tags.get("building:levels"))
        mh = num(tags.get("min_height"))
        min_level = num(tags.get("building:min_level"))
        kind = BUILDING_KIND.get(btype, 0)
        if h is None and is_bridge:
            h = 3.2  # above its soffit: deck and an enclosed walkway's walls
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
        if tags.get("amenity") == "bus_station" or tags.get("public_transport") == "station":
            b["_st"] = 1  # station outline (a canopy source for stations.py); dropped before writing
        # for stations.drop_shelters (keys starting with "_" are dropped before writing)
        if tags.get("amenity") == "shelter" or tags.get("shelter_type") == "public_transport" or btype in ("train_station", "transportation"):
            b["_sh"] = 1
        layer = num(tags.get("layer")) or 0
        if layer >= 1 and not mh:
            b["_up"] = 1  # on an upper level (a deck, a viaduct station) with no min_height
        if is_bridge:
            b["_br"] = 1
            b.pop("k", None)
        b["_id"] = osm_id
        self.buildings.append(b)


FOOTPATH = 1.5  # m kept between a kerb and a building face (cap_widths)
BRIDGE_PATHS = ("footway", "cycleway", "path", "steps", "bridleway")
BRIDGE_PARAPET = 0.3  # m of a bridge outline's width taken by each parapet (bridge_widths)
BRIDGE_W_MAX = 10.5  # m: the widest deck bridge_widths gives a two-way busway


def bridge_widths(h: "Handler") -> int:
    """Two-way bus ways on a bridge with no width or lanes tags take the deck
    width of the man_made=bridge outline they run along, instead of the 7.4 m
    default (two 3.5 m lanes + 0.4): the RBWH busway bridge (way 423268770 in
    outline 766218372) is 9.5-13.4 m wide, and on a 7.4 m deck two buses could
    not pass. Every 2 m along the way inside the outline, across it: the
    distance to the outline's edge on each side, or, if nearer, half way to
    another road on a bridge or 1.5 m short of a footway or cycleway on one
    (ways that meet or cross the way do not count). The deck is twice the
    nearer side less a parapet; the way takes the 20th percentile of that along
    it, never narrower than it was and at most BRIDGE_W_MAX."""
    import shapely

    from elevation import RAIL

    if not h.bridge_decks:
        return 0
    decks = h.bridge_decks
    dtree = shapely.STRtree(decks)
    others = [(LineString(ln.xy), True, ln.id) for ln in h.lines if ln.kind != RAIL and ln.bridge and len(ln.xy) >= 2]
    others += [(LineString(p), False, -1) for p in h.bridge_paths]
    otree = shapely.STRtree([o[0] for o in others])
    n = 0
    for ln in h.lines:
        m = ln.meta
        if ln.kind != 7 or not ln.bridge or m.get("o") or ln.id in h.width_tagged or ln.id in h.lanes_tagged or len(ln.xy) < 2:
            continue
        line = LineString(ln.xy)
        L = line.length
        if L < 10:
            continue
        best, share = None, 0.0
        for i in dtree.query(line, predicate="intersects"):
            f = decks[int(i)].buffer(1.0).intersection(line).length / L
            if f > share:
                best, share = int(i), f
        if best is None or share < 0.6:
            continue
        P = decks[best]
        edge = P.boundary
        near = [others[int(j)] for j in otree.query(P, predicate="intersects")]
        near = [(g, road) for g, road, oid in near if oid != ln.id and not g.intersects(line)]
        ws = []
        for s in np.arange(1.0, L - 1.0 + 1e-6, 2.0):
            a = line.interpolate(s)
            if not P.contains(a):
                continue
            b = line.interpolate(min(L, s + 0.5))
            c = line.interpolate(max(0.0, s - 0.5))
            tl = float(np.hypot(b.x - c.x, b.y - c.y)) or 1.0
            nx, ny = -(b.y - c.y) / tl, (b.x - c.x) / tl
            free = []
            for sg in (1.0, -1.0):
                ray = LineString([(a.x, a.y), (a.x + sg * nx * 30.0, a.y + sg * ny * 30.0)])
                ts = [float(np.hypot(q[0] - a.x, q[1] - a.y)) for q in shapely.get_coordinates(ray.intersection(edge))]
                if not ts:
                    break
                d = min(ts)
                for g, road in near:
                    for q in shapely.get_coordinates(ray.intersection(g)):
                        t = float(np.hypot(q[0] - a.x, q[1] - a.y))
                        if t < d:
                            d = min(d, t / 2.0 if road else t - 1.5)
                free.append(d)
            if len(free) == 2:
                ws.append(2.0 * (min(free) - BRIDGE_PARAPET))
        if len(ws) < 3:
            continue
        wn = min(BRIDGE_W_MAX, float(np.percentile(ws, 20)))
        if wn > float(m["w"]) + 0.3:
            print(f"widths: bridge way {ln.id} '{ln.name}' {m['w']} -> {wn:.1f} m ({L:.0f} m long)", file=sys.stderr)
            m["w"] = round(wn, 1)
            n += 1
    return n


def name_bridges(h: "Handler") -> int:
    """Busway bridge ways inside a named man_made=bridge outline, with no
    bridge:name of their own, take the bridge's name as their road name, so the
    HUD names the bridge (Eleanor Schonell Bridge, rel 15398560, carries ways
    named "Eastern Busway": M2 review #20). The way must run along the bridge
    (within 25 degrees of the outline's long axis), not under or across it.
    Only bus ways: other roads keep their street name (landmarks.ts finds the
    Story Bridge deck by "Bradfield Highway")."""
    if not h.bridge_outlines:
        return 0
    from shapely import STRtree
    polys = [p for p, _ in h.bridge_outlines]
    tree = STRtree(polys)
    axes = []
    for p in polys:
        r = np.asarray(p.minimum_rotated_rectangle.exterior.coords)
        e = [r[1] - r[0], r[2] - r[1]]
        u = max(e, key=lambda v: float(np.hypot(*v)))
        axes.append(u / max(float(np.hypot(*u)), 1e-9))
    n = 0
    for ln in h.lines:
        if not ln.bridge or not ln.meta.get("bus") or ln.meta.get("_bn") or len(ln.xy) < 2:
            continue
        line = LineString(ln.xy)
        best, share = None, 0.0
        for i in tree.query(line, predicate="intersects"):
            f = polys[int(i)].buffer(2.0).intersection(line).length / max(line.length, 1e-6)
            if f > share:
                best, share = int(i), f
        if best is None or share < 0.6:
            continue
        d = np.asarray(ln.xy[-1], float) - np.asarray(ln.xy[0], float)
        if abs(float(d @ axes[best])) < 0.9 * max(float(np.hypot(*d)), 1e-9):
            continue
        nm = h.bridge_outlines[best][1]
        ln.meta["n"] = h.name(nm)
        ln.name = nm
        n += 1
    return n


JOIN_GAP = 1.0  # m: way ends this close that share no node are one junction mapped twice
SHORT_WAY = 1.0  # m: elevation.build drops output pieces shorter than this


def join_near_ends(lines) -> tuple[list, dict[int, int], int, int]:
    """Road junctions OSM maps as two nodes a hand's width apart become one node
    (the lower id's), so the roads meet:
    - a vehicle way shorter than SHORT_WAY between them (elevation.build drops
      such pieces, which left the roads either side unjoined: the 0.92 m way
      1216686378 between Macgregor Terrace and Latrobe Terrace at (-3442, 1045),
      a car-graph dead end, 61/0 s 2296) is contracted to its first node;
    - vehicle way ends within JOIN_GAP of another way's end on the same OSM
      level, with no way between them (never a way's two ends to each other).
    Returns (the lines left, merged node ids old -> kept, ways contracted,
    ends joined)."""
    PED = 8
    road = [ln for ln in lines if ln.kind not in (elevation.RAIL, PED) and len(ln.nodes) >= 2]
    to: dict[int, int] = {}

    def root(n: int) -> int:
        while n in to:
            n = to[n]
        return n

    def union(a: int, b: int) -> bool:
        a, b = root(a), root(b)
        if a == b:
            return False
        to[max(a, b)] = min(a, b)
        return True

    pos: dict[int, tuple[float, float]] = {}
    for ln in road:
        for nid, xy in zip(ln.nodes, ln.xy):
            pos.setdefault(nid, xy)
    drop: set[int] = set()
    for ln in road:
        if len(set(ln.nodes)) < 2:
            continue
        length = sum(math.hypot(x1 - x0, y1 - y0) for (x0, y0), (x1, y1) in zip(ln.xy[:-1], ln.xy[1:]))
        if length < SHORT_WAY:
            for nid in ln.nodes[1:]:
                union(ln.nodes[0], nid)
            drop.add(id(ln))
    contracted = len(drop)
    ends: dict[int, tuple[float, float, int]] = {}
    ways: dict[int, set[int]] = {}
    linked: set[tuple[int, int]] = set()
    for i, ln in enumerate(road):
        if id(ln) in drop:
            continue
        for k in (0, len(ln.nodes) - 1):
            ends.setdefault(ln.nodes[k], (ln.xy[k][0], ln.xy[k][1], ln.level))
            ways.setdefault(ln.nodes[k], set()).add(i)
        for a, b in zip(ln.nodes[:-1], ln.nodes[1:]):
            linked.add((min(a, b), max(a, b)))
    ids = sorted(ends)
    cell: dict[tuple[int, int], list[int]] = {}
    for nid in ids:
        x, y, _ = ends[nid]
        cell.setdefault((int(x // 2), int(y // 2)), []).append(nid)
    joined = 0
    for nid in ids:
        x, y, lv = ends[nid]
        gx, gy = int(x // 2), int(y // 2)
        for ax in (-1, 0, 1):
            for ay in (-1, 0, 1):
                for m in cell.get((gx + ax, gy + ay), []):
                    if m <= nid:
                        continue
                    x2, y2, lv2 = ends[m]
                    if lv2 != lv or math.hypot(x2 - x, y2 - y) > JOIN_GAP or (nid, m) in linked or ways[nid] & ways[m]:
                        continue
                    if union(nid, m):
                        joined += 1
    out = {n: root(n) for n in to}
    for ln in road:
        if id(ln) in drop:
            continue
        nodes: list[int] = []
        xy: list[tuple[float, float]] = []
        for nid, p in zip(ln.nodes, ln.xy):
            r = out.get(nid, nid)
            if r != nid:
                p = pos[r]
            if nodes and nodes[-1] == r:
                continue
            nodes.append(r)
            xy.append(p)
        if len(nodes) >= 2:
            ln.nodes, ln.xy = nodes, xy
    return [ln for ln in lines if id(ln) not in drop], out, contracted, joined


def cap_widths(lines, buildings, tagged: set[int]) -> None:
    """Default road widths (lanes x lane width) that do not fit between the
    buildings along the road are narrowed to the building-free corridor less a
    footpath each side, never below what the lanes need (two-way 5.5 m). OSM
    lane counts on old streets (Brunswick St, Caxton St, Given Tce) otherwise
    put the kerb lane inside the shop fronts (199 review #3, 61 #2)."""
    import numpy as np
    import shapely

    from elevation import RAIL

    polys = []
    for b in buildings:
        if b.get("k") == 8:  # roofs and canopies may reach over a road
            continue
        p = np.asarray(b["p"], dtype=np.float64).reshape(-1, 2) * 0.1
        if len(p) >= 3:
            polys.append(shapely.Polygon(p))
    polys = np.asarray(polys, dtype=object)
    tree = shapely.STRtree(polys)
    n = 0
    for ln in lines:
        if ln.kind == RAIL or ln.kind > 6 or ln.bridge or ln.tunnel or ln.id in tagged:
            continue
        w = float(ln.meta["w"])
        line = shapely.LineString(ln.xy)
        L = line.length
        if L < 16:
            continue
        cand = tree.query(line, predicate="dwithin", distance=0.5 * w + FOOTPATH)
        if not len(cand):
            continue
        cand = [int(c) for c in cand if not polys[int(c)].intersects(line)]  # over-road structures
        if not cand:
            continue
        ss = np.arange(6.0, L - 6.0 + 1e-6, 4.0)
        if not len(ss):
            continue
        pts = shapely.line_interpolate_point(line, ss)
        d = shapely.distance(pts[:, None], polys[cand][None, :]).min(axis=1)
        corridor = float(np.percentile(d, 5))
        two_way = not ln.meta.get("o")
        lanes = int(ln.meta.get("l", 2))
        minw = max(5.5, 2.75 * min(lanes, 2)) if two_way else max(3.5, 2.75 * min(lanes, 2))
        cap = max(minw, 2.0 * (corridor - FOOTPATH))
        if cap < w - 0.2:
            ln.meta["w"] = round(cap, 1)
            n += 1
    print(f"widths: {n} roads narrowed to the building corridor", file=sys.stderr)


def signal_roads(signal_nodes, lines, roads):
    """For every traffic signal: the output road it stands on (index, or -1 for
    signals on paths and cycleways only, e.g. bike crossings), the direction it
    faces traffic in along that road's polyline (+1 forward, -1 backward, 0 both
    or unknown; from traffic_signals:direction) and the road height at it (dm;
    ground for -1)."""
    import build_terrain
    import numpy as np

    want = {nid for nid, *_ in signal_nodes}
    on: dict[int, list] = {}
    for ln in lines:
        if ln.kind == elevation.RAIL or not ln.emit:
            continue
        last = len(ln.nodes) - 1
        for k, nid in enumerate(ln.nodes):
            if nid in want:
                on.setdefault(nid, []).append((ln, 0 < k < last))
    recs_of: dict[int, list[int]] = {}
    for i, r in enumerate(roads):
        ln = r.get("_ln")
        if ln is not None:
            recs_of.setdefault(id(ln), []).append(i)
    inner, outer, _ = build_terrain.read_terrain()
    ground = build_terrain.ground_sampler(inner, outer)
    rr, dd, zz = [], [], []
    for nid, x, y, d in signal_nodes:
        best = None
        for ln, interior in on.get(nid, []):
            for i in recs_of.get(id(ln), []):
                p = np.asarray(roads[i]["p"], dtype=np.float64).reshape(-1, 2) * 0.1
                z = np.asarray(roads[i]["z"], dtype=np.float64) * 0.1
                a, b = p[:-1], p[1:]
                v = b - a
                L2 = np.maximum((v * v).sum(1), 1e-12)
                t = np.clip(((x - a[:, 0]) * v[:, 0] + (y - a[:, 1]) * v[:, 1]) / L2, 0, 1)
                dist = np.hypot(x - a[:, 0] - t * v[:, 0], y - a[:, 1] - t * v[:, 1])
                j = int(np.argmin(dist))
                if dist[j] > 0.6:
                    continue
                key = (not interior, roads[i]["k"], float(dist[j]))
                if best is None or key < best[0]:
                    best = (key, i, float(z[j] + t[j] * (z[j + 1] - z[j])), -d if ln.reversed else d)
        if best is None:
            rr.append(-1)
            dd.append(0)
            zz.append(q(float(ground(np.array([x]), np.array([y]))[0])))
        else:
            rr.append(best[1])
            dd.append(best[3])
            zz.append(q(best[2]))
    n_off = sum(1 for v in rr if v < 0)
    print(f"signals {len(rr)}: {len(rr) - n_off} on roads, {n_off} on paths only, {sum(1 for v in dd if v)} with a direction", file=sys.stderr)
    return rr, dd, zz


def main():
    h = Handler()
    print("reading", PBF, file=sys.stderr)
    h.apply_file(PBF, locations=True, idx="flex_mem")

    print(f"road and rail ways {len(h.lines)} buildings {len(h.buildings)} areas {len(h.areas)} water {len(h.water_polys)}", file=sys.stderr)
    h.lines, moved, n_short, n_near = join_near_ends(h.lines)
    print(f"joins: {n_short} road ways under {SHORT_WAY} m contracted to a node, {n_near} way ends within {JOIN_GAP} m of another joined"
          f" ({len(moved)} nodes merged at {len(set(moved.values()))} places)", file=sys.stderr)
    # (a signal on a node joined away stands on the node it was joined to)
    if moved:
        kept = set(moved.values())
        at = {nid: xy for ln in h.lines for nid, xy in zip(ln.nodes, ln.xy) if nid in kept}
        sig = []
        for nid, x, y, d in h.signal_nodes:
            r = moved.get(nid, nid)
            if r != nid and r in at:
                x, y = at[r]
            sig.append((r, x, y, d))
        h.signal_nodes = sig
        h.signals = [v for _, x, y, _ in sig for v in (q(x), q(y))]

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

    nb = name_bridges(h)
    print(f"bridges: {nb} bridge ways named after the man_made=bridge outline they lie in", file=sys.stderr)
    nw = bridge_widths(h)
    print(f"widths: {nw} two-way busway bridges widened to their bridge outline", file=sys.stderr)
    cap_widths(h.lines, h.buildings, h.width_tagged)
    # Heights: terrain cleaning, the road/rail solve, station platforms and bays,
    # terrain.bin, building bases.
    roads, rail, platforms, buildings = elevation.build(h.lines, water_out, h.buildings, h.areas, CLIP_PAD.bounds, h.platforms)
    print(f"roads {len(roads)} rail {len(rail)}", file=sys.stderr)
    sig_road, sig_dir, sig_z = signal_roads(h.signal_nodes, h.lines, roads)
    for r in roads + rail:
        r.pop("_ln", None)
        r.pop("_bn", None)
    for b in buildings:
        for k in ("_st", "_sh", "_up", "_id", "_br"):
            b.pop(k, None)
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
        json.dump({**meta, "names": names, "roads": roads, "rail": rail, "signals": h.signals,
                   "sigr": sig_road, "sigd": sig_dir, "sigz": sig_z, "crossings": h.crossings,
                   "walls": h.retaining}, f, separators=(",", ":"))
    print("retaining walls", len(h.retaining), file=sys.stderr)
    with open(os.path.join(OUT, "buildings.json"), "w") as f:
        json.dump({**meta, "buildings": buildings}, f, separators=(",", ":"))
    with open(os.path.join(OUT, "areas.json"), "w") as f:
        json.dump({**meta, "water": water_out, "areas": h.areas, "trees": h.trees}, f, separators=(",", ":"))
    with open(os.path.join(OUT, "platforms.json"), "w") as f:
        json.dump({**meta, "platforms": platforms}, f, separators=(",", ":"))
    print("platforms", len(platforms), file=sys.stderr)
    for name in ("roads.json", "buildings.json", "areas.json"):
        print(name, os.path.getsize(os.path.join(OUT, name)) // 1024, "KB", file=sys.stderr)


if __name__ == "__main__":
    main()
