"""Busway stations: platforms, stopping bays and station buildings.

Runs inside elevation.build() once the road heights are solved, on the
output road records (decimetre ints with "z"):

1. Platforms. OSM maps busway platforms as areas, as lines (the walkway along
   the platform: Mater Hill, Buranda, Herston, Normanby) or not at all
   (Boggo Road, Greenslopes and UQ Lakes have only stop nodes). Every
   platform leaves here as a polygon ("a": 1):
   - a line becomes a slab whose face is up to LINE_FACE m in front of the
     line (towards the busway, never past its edge) and whose back is
     LINE_BACK m behind it;
   - a line that duplicates an area platform (Normanby) is dropped;
   - GTFS station stops with no platform get one, cut from the canopy roof
     or station outline over them (Boggo Road, Greenslopes, UQ Lakes) or a
     default slab;
   - unnamed platforms take the name and platform code of their GTFS stop;
   - "u" (underground) means the busway beside the platform is a tunnel.
2. Stopping bays. Real stations are 4-lane (a stopping lane each way outside
   the 2 through lanes, 14-15 m between platform faces) but OSM maps one
   7.4 m busway through them. Each platform kerb that stands off its busway
   gets synthetic one-way carriageways ("bay": 1) filling the space from the
   busway to the kerb, at the busway's solved height (so on the viaduct at
   PA Hospital, in the cuttings at Buranda and Mater Hill, in the tunnel
   hall at King George Square), tapering into the busway beyond the platform
   ends and split where the busway changes structure, so each piece carries
   the busway's bridge / tunnel / layer flags (and "tb", boxed end to end).
3. Buildings. Station shelters duplicating a platform footprint are dropped
   (the platform is drawn covered instead); canopy roofs (kind 8) over a
   busway or platform get their base from the road under them, in sections
   along the road on grades (roof_bases(), after building_bases()).
"""

from __future__ import annotations

import collections
import csv
import heapq
import io
import math
import os
import sys
import zipfile

import numpy as np
import shapely
import shapely.affinity

from common import RAW, in_bbox, project, q

GTFS_ZIP = os.path.join(RAW, "SEQ_GTFS.zip")
GTFS_DIR = os.path.join(RAW, "gtfs")

KERB_SEARCH = 16.0  # m: the busway a platform edge faces (as src/game/platforms.ts)
LINE_FACE = 4.0  # m: platform face in front of an OSM platform line, at most
LINE_BACK = 1.0  # m: platform back behind the line
MIN_DEPTH = 3.5  # m: platform depth at least
BAY_MIN_GAP = 0.4  # m: kerb this far off the busway edge gets a bay
BAY_UNDER = 0.3  # m: bay edge reaches this far under the platform slab
BAY_OVERLAP = 1.0  # m: bay inner edge this far inside the busway
BAY_MAX_W = 6.5  # m: widest single bay strip
TAPER_PER_M = 7.0  # taper length per metre of offset
TAPER_MIN, TAPER_MAX = 20.0, 50.0
STEP = 2.0  # m: bay sampling
SYNTH_LEN = 60.0  # m: default length of a synthesised platform
SYNTH_FACE = 3.6  # m: default face beyond the busway edge (one stopping lane)
SYNTH_DEPTH = 4.0
CANOPY_CLEAR = 5.6  # m: canopy roof top above the road / platform under it (its 0.6 m slab clears 5 m: M2 #26)
CANOPY_SECTION = 20.0  # m: canopy sections along a grade
STATION_W = 15.0  # m: face to face across a two-sided busway station at most (imagery: 14-15 m)


def log(msg: str) -> None:
    print("stations: " + msg, file=sys.stderr)


def ring(flat) -> np.ndarray:
    return np.asarray(flat, dtype=np.float64).reshape(-1, 2) * 0.1


def flat(xy) -> list[int]:
    return [int(v) for v in np.rint(np.asarray(xy, dtype=np.float64) * 10).ravel()]


# ---------------------------------------------------------------------------
# GTFS station stops


def gtfs_station_stops() -> list[dict]:
    """Stops that are platforms of a station (parent_station set), inside the map."""
    path = os.path.join(GTFS_DIR, "stops.txt")
    if os.path.exists(path):
        text = open(path, encoding="utf-8-sig").read()
    elif os.path.exists(GTFS_ZIP):
        with zipfile.ZipFile(GTFS_ZIP) as z:
            text = z.read("stops.txt").decode("utf-8-sig")
    else:
        return []
    out = []
    for s in csv.DictReader(io.StringIO(text)):
        if s.get("location_type", "0") not in ("", "0") or not s.get("parent_station"):
            continue
        lon, lat = float(s["stop_lon"]), float(s["stop_lat"])
        if not in_bbox(lon, lat):
            continue
        x, y = project(lon, lat)
        out.append({"x": x, "y": y, "name": s["stop_name"].strip(), "code": (s.get("platform_code") or "").strip(),
                    "parent": s["parent_station"]})
    return out


# ---------------------------------------------------------------------------
# Bus road network


class BusNet:
    """The bus roads (busways and bus=yes ways) of the output, for host lookups and chains."""

    def __init__(self, roads: list[dict]):
        self.roads = roads
        self.ids = [i for i, r in enumerate(roads) if (r.get("bus") or r["k"] == 7) and not r.get("bay")]
        self.P = {i: ring(roads[i]["p"]) for i in self.ids}
        self.Z = {i: np.asarray(roads[i]["z"], dtype=np.float64) * 0.1 for i in self.ids}
        A, B, ZA, ZB, RID, SEG = [], [], [], [], [], []
        for i in self.ids:
            p, z = self.P[i], self.Z[i]
            A.append(p[:-1])
            B.append(p[1:])
            ZA.append(z[:-1])
            ZB.append(z[1:])
            RID.append(np.full(len(p) - 1, i))
            SEG.append(np.arange(len(p) - 1))
        self.a = np.concatenate(A)
        self.b = np.concatenate(B)
        self.za = np.concatenate(ZA)
        self.zb = np.concatenate(ZB)
        self.rid = np.concatenate(RID)
        self.seg = np.concatenate(SEG)
        d = self.b - self.a
        self.len = np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-9)
        self.dir = d / self.len[:, None]
        self.hw = np.asarray([0.5 * roads[i]["w"] for i in self.rid])
        self.tun = np.asarray([bool(roads[i].get("t")) for i in self.rid])
        self.bri = np.asarray([bool(roads[i].get("b")) for i in self.rid])
        self.k7 = np.asarray([roads[i]["k"] == 7 for i in self.rid])
        self.ends: dict[tuple[int, int], list[tuple[int, int]]] = collections.defaultdict(list)
        for i in self.ids:
            pf = roads[i]["p"]
            self.ends[(pf[0], pf[1])].append((i, 0))
            self.ends[(pf[-2], pf[-1])].append((i, 1))

    def project(self, x: float, y: float):
        """Distance, parameter and foot point on every segment."""
        t = np.clip(((x - self.a[:, 0]) * self.dir[:, 0] + (y - self.a[:, 1]) * self.dir[:, 1]) / self.len, 0.0, 1.0)
        fx = self.a[:, 0] + (self.b[:, 0] - self.a[:, 0]) * t
        fy = self.a[:, 1] + (self.b[:, 1] - self.a[:, 1]) * t
        return np.hypot(x - fx, y - fy), t, fx, fy

    def nearest(self, x: float, y: float, maxd: float, mask=None) -> int:
        d, _, _, _ = self.project(x, y)
        if mask is not None:
            d = np.where(mask, d, np.inf)
        j = int(np.argmin(d))
        return j if d[j] <= maxd else -1

    def road_chain(self, rid: int, ahead: float, behind: float, at: float):
        """A polyline along road rid continued through connected bus roads,
        reaching `ahead` m past arc length `at` of rid and `behind` m before it.
        Returns (xy, z, road id per segment, arc length of `at` on the chain)."""
        p, z = self.P[rid], self.Z[rid]
        pts = [p]
        zs = [z]
        segr = [np.full(len(p) - 1, rid)]
        used = {rid}
        length = float(np.hypot(*np.diff(p, axis=0).T).sum())
        fwd = length - at
        back = at
        head_xy = (self.roads[rid]["p"][-2], self.roads[rid]["p"][-1])
        tail_xy = (self.roads[rid]["p"][0], self.roads[rid]["p"][1])
        head_dir = p[-1] - p[-2]
        tail_dir = p[0] - p[1]
        while fwd < ahead:
            nxt = self._continue(head_xy, head_dir, used, rid, forward=True)
            if nxt is None:
                break
            j, rev = nxt
            q_, zq = (self.P[j][::-1], self.Z[j][::-1]) if rev else (self.P[j], self.Z[j])
            pts.append(q_[1:])
            zs.append(zq[1:])
            segr.append(np.full(len(q_) - 1, j))
            used.add(j)
            fwd += float(np.hypot(*np.diff(q_, axis=0).T).sum())
            head_xy = (int(round(q_[-1, 0] * 10)), int(round(q_[-1, 1] * 10)))
            head_dir = q_[-1] - q_[-2]
        while back < behind:
            nxt = self._continue(tail_xy, tail_dir, used, rid, forward=False)
            if nxt is None:
                break
            j, rev = nxt
            # rev: the road runs away from the tail, so it is reversed to lead into it
            q_, zq = (self.P[j][::-1], self.Z[j][::-1]) if rev else (self.P[j], self.Z[j])
            pts.insert(0, q_[:-1])
            zs.insert(0, zq[:-1])
            segr.insert(0, np.full(len(q_) - 1, j))
            used.add(j)
            ln = float(np.hypot(*np.diff(q_, axis=0).T).sum())
            back += ln
            at += ln
            tail_xy = (int(round(q_[0, 0] * 10)), int(round(q_[0, 1] * 10)))
            tail_dir = q_[0] - q_[1]
        return np.concatenate(pts), np.concatenate(zs), np.concatenate(segr), at

    def _continue(self, end_xy, end_dir, used, rid0, forward: bool):
        """The bus road that carries on most straight from a chain end."""
        best = None
        best_turn = math.radians(35)
        ed = end_dir / max(1e-9, float(np.hypot(*end_dir)))
        oneway0 = bool(self.roads[rid0].get("o"))
        for j, which in self.ends.get(end_xy, []):
            if j in used:
                continue
            p = self.P[j]
            if which == 0:  # starts here: leads away from the end as stored
                d = p[1] - p[0]
                rev = False
            else:  # ends here: reversed it leads away
                d = p[-2] - p[-1]
                rev = True
            # chain direction: forward chains need the road leading away from the head;
            # backward chains need it leading into the tail (i.e. away from it, reversed)
            if not forward:
                rev = not rev
            if oneway0 and self.roads[j].get("o") and rev:
                continue  # against the flow of a one-way pair
            dl = float(np.hypot(*d))
            if dl < 1e-6:
                continue
            turn = math.acos(max(-1.0, min(1.0, float(ed @ (d / dl)))))
            if turn < best_turn:
                best_turn = turn
                best = (j, rev)
        return best


class Chain:
    """A host polyline with arc length, unit normals (left) and per-segment road ids."""

    def __init__(self, xy: np.ndarray, z: np.ndarray, segr: np.ndarray, roads: list[dict]):
        keep = np.concatenate([[True], np.hypot(*np.diff(xy, axis=0).T) > 1e-6])
        # drop zero-length segments, keeping segr aligned with the remaining segments
        idx = np.flatnonzero(keep)
        self.xy = xy[idx]
        self.z = z[idx]
        self.segr = segr[idx[1:] - 1] if len(idx) > 1 else segr[:0]
        d = np.diff(self.xy, axis=0)
        L = np.hypot(d[:, 0], d[:, 1])
        self.cum = np.concatenate([[0.0], np.cumsum(L)])
        self.length = float(self.cum[-1])
        t = d / L[:, None]
        nseg = np.stack([-t[:, 1], t[:, 0]], 1)
        nv = np.zeros_like(self.xy)
        nv[:-1] += nseg
        nv[1:] += nseg
        nv /= np.maximum(np.hypot(nv[:, 0], nv[:, 1]), 1e-9)[:, None]
        self.nv = nv
        self.tseg = t
        self.roads = roads
        self.hw_seg = np.asarray([0.5 * roads[int(r)]["w"] for r in self.segr])

    def seg_at(self, s):
        return np.clip(np.searchsorted(self.cum, s, side="right") - 1, 0, len(self.cum) - 2)

    def at(self, s):
        """Position, height, unit left normal and half width at arc lengths s."""
        s = np.clip(np.asarray(s, dtype=np.float64), 0.0, self.length)
        k = self.seg_at(s)
        f = (s - self.cum[k]) / np.maximum(self.cum[k + 1] - self.cum[k], 1e-9)
        xy = self.xy[k] + (self.xy[k + 1] - self.xy[k]) * f[..., None]
        z = self.z[k] + (self.z[k + 1] - self.z[k]) * f
        n = self.nv[k] + (self.nv[k + 1] - self.nv[k]) * f[..., None]
        n /= np.maximum(np.hypot(n[..., 0], n[..., 1]), 1e-9)[..., None]
        return xy, z, n, self.hw_seg[k]

    def locate(self, pts: np.ndarray):
        """Arc length and signed offset (+ left) of points on the chain."""
        a = self.xy[:-1]
        b = self.xy[1:]
        d = b - a
        L2 = np.maximum((d * d).sum(1), 1e-12)
        s_out = np.zeros(len(pts))
        e_out = np.zeros(len(pts))
        for i, (x, y) in enumerate(pts):
            t = np.clip(((x - a[:, 0]) * d[:, 0] + (y - a[:, 1]) * d[:, 1]) / L2, 0, 1)
            fx = a[:, 0] + d[:, 0] * t
            fy = a[:, 1] + d[:, 1] * t
            dist = np.hypot(x - fx, y - fy)
            k = int(np.argmin(dist))
            cr = d[k, 0] * (y - a[k, 1]) - d[k, 1] * (x - a[k, 0])
            s_out[i] = self.cum[k] + t[k] * math.sqrt(L2[k])
            e_out[i] = math.copysign(dist[k], cr)
        return s_out, e_out

    def flags_at(self, s: float) -> tuple:
        r = self.roads[int(self.segr[int(self.seg_at(s))])]
        return (int(r.get("b", 0)), int(r.get("t", 0)), int(r.get("y", 0)), int(r.get("tb", 0)))


# ---------------------------------------------------------------------------
# Platforms


def _level_penalty(net: BusNet, under: bool | None, raised: bool) -> np.ndarray:
    pen = np.zeros(len(net.rid))
    if under is True:
        pen += np.where(net.tun, 0.0, 30.0)
    elif under is False:
        pen += np.where(net.tun, 8.0, 0.0)
    if raised:
        pen += np.where(net.bri, 0.0, 6.0)
    return pen


def host_segment(net: BusNet, x: float, y: float, under: bool | None, raised: bool, maxd: float = 20.0,
                 tangent=None, side=None) -> int:
    """Best bus road segment beside a platform point (level-aware); -1 if none."""
    d, t, fx, fy = net.project(x, y)
    score = d + _level_penalty(net, under, raised)
    ok = d <= maxd
    if tangent is not None:
        ok &= np.abs(net.dir @ np.asarray(tangent)) > 0.8
    if side is not None:
        ok &= (fx - x) * side[0] + (fy - y) * side[1] > -0.5
    score = np.where(ok, score, np.inf)
    j = int(np.argmin(score))
    return j if np.isfinite(score[j]) else -1


def line_to_polygon(pl: dict, net: BusNet) -> np.ndarray | None:
    """Slab polygon for a platform mapped as a line (see the module doc)."""
    p = ring(pl["p"])
    line = shapely.LineString(p)
    if line.length < 2:
        return None
    mid = line.interpolate(0.5, normalized=True)
    j = host_segment(net, mid.x, mid.y, pl.get("_under"), pl.get("y", 0) > 0)
    if j < 0:
        poly = line.buffer(0.5 * MIN_DEPTH, cap_style="flat")
        return np.asarray(poly.exterior.coords)[:-1]
    # which side of the line the busway is on: shapely offsets positive to the left
    fx, fy = net.a[j] + net.dir[j] * np.clip((np.array([mid.x, mid.y]) - net.a[j]) @ net.dir[j], 0, net.len[j])
    dist = math.hypot(fx - mid.x, fy - mid.y)
    k = int(np.argmin(np.hypot(p[:-1, 0] - mid.x, p[:-1, 1] - mid.y) + np.hypot(p[1:, 0] - mid.x, p[1:, 1] - mid.y)))
    tx, ty = p[k + 1] - p[k]
    left = (-ty * (fx - mid.x) + tx * (fy - mid.y)) > 0
    gap = dist - net.hw[j]
    face = min(LINE_FACE, max(0.0, gap))
    back = max(LINE_BACK, MIN_DEPTH - face)
    sgn = 1.0 if left else -1.0
    a = line.offset_curve(sgn * face) if face > 0.05 else line
    b = line.offset_curve(-sgn * back)
    if a.is_empty or b.is_empty or a.geom_type != "LineString" or b.geom_type != "LineString":
        poly = line.buffer(0.5 * MIN_DEPTH, cap_style="flat")
        return np.asarray(poly.exterior.coords)[:-1]
    pa = np.asarray(a.coords)
    pb = np.asarray(b.coords)
    # offset_curve keeps the direction of the input line for both signs (shapely 2)
    poly = shapely.Polygon(np.concatenate([pa, pb[::-1]]))
    if not poly.is_valid:
        poly = poly.buffer(0)
        if poly.geom_type != "Polygon":
            poly = max(getattr(poly, "geoms", [poly]), key=lambda g: g.area)
    poly = shapely.orient_polygons(poly) if hasattr(shapely, "orient_polygons") else poly
    return np.asarray(poly.exterior.coords)[:-1]


def side_band(chain: Chain, s0: float, s1: float, e0: float, e1: float, sgn: float) -> shapely.Polygon:
    """The region between offsets e0..e1 on side sgn of the chain over s0..s1."""
    s = np.linspace(s0, s1, max(2, int((s1 - s0) / 2.0) + 1))
    xy, _, n, _ = chain.at(s)
    a = xy + n * (sgn * e0)
    b = xy + n * (sgn * e1)
    poly = shapely.Polygon(np.concatenate([a, b[::-1]]))
    return poly if poly.is_valid else poly.buffer(0)


def synthesise(stop: dict, net: BusNet, canopies: list[tuple[shapely.Polygon, int]]) -> tuple[np.ndarray, str] | None:
    """A platform polygon for a station stop that has none."""
    j = net.nearest(stop["x"], stop["y"], 20.0, net.k7 & ~net.tun)
    if j < 0:
        return None
    rid = int(net.rid[j])
    at = float(np.hypot(*np.diff(net.P[rid][: net.seg[j] + 1], axis=0).T).sum()) if net.seg[j] > 0 else 0.0
    at += float((np.array([stop["x"], stop["y"]]) - net.a[j]) @ net.dir[j])
    xy, z, segr, at = net.road_chain(rid, 120.0, 120.0, at)
    ch = Chain(xy, z, segr, net.roads)
    s_stop, e_stop = ch.locate(np.array([[stop["x"], stop["y"]]]))
    s_stop, e_stop = float(s_stop[0]), float(e_stop[0])
    sgn = 1.0 if e_stop >= 0 else -1.0
    hw = float(net.hw[j])
    s0, s1 = max(0.0, s_stop - 70.0), min(ch.length, s_stop + 70.0)
    band = side_band(ch, s0, s1, hw + 0.2, hw + 14.0, sgn)
    best = None
    for poly, bi in canopies:
        if poly.distance(shapely.Point(stop["x"], stop["y"])) > 15.0:
            continue
        piece = poly.intersection(band)
        for g in getattr(piece, "geoms", [piece]):
            if g.geom_type != "Polygon" or g.area < 30:
                continue
            dd = g.distance(shapely.Point(stop["x"], stop["y"]))
            if best is None or dd < best[0]:
                best = (dd, g, bi)
    if best is not None:
        g = best[1]
        pts = np.asarray(g.exterior.coords)
        ss, ee = ch.locate(pts)
        ee = ee * sgn
        a0, a1 = float(ss.min()), float(ss.max())
        # a canopy can also reach over the busway: the face is then a stopping lane out
        face = max(float(np.percentile(ee, 5)), hw + SYNTH_FACE)
        back = min(float(np.percentile(ee, 95)), face + 6.0)
        back = max(back, face + MIN_DEPTH)
        src = "canopy %d" % best[2]
    else:
        a0, a1 = max(0.0, s_stop - 0.5 * SYNTH_LEN), min(ch.length, s_stop + 0.5 * SYNTH_LEN)
        face = hw + SYNTH_FACE
        back = face + SYNTH_DEPTH
        src = "default"
    poly = side_band(ch, a0, a1, face, back, sgn)
    if poly.is_empty or poly.geom_type != "Polygon":
        return None
    return np.asarray(poly.simplify(0.1).exterior.coords)[:-1], src


def normalise_platforms(platforms: list[dict], net: BusNet, buildings: list[dict], stops: list[dict]) -> list[dict]:
    out: list[dict] = []
    # 1. lines -> polygons; areas kept
    polys = []
    for pl in platforms:
        if pl.get("a"):
            poly = ring(pl["p"])
            src = "area"
        else:
            poly = line_to_polygon(pl, net)
            src = "line"
        if poly is None or len(poly) < 3:
            continue
        sp = shapely.Polygon(poly)
        if not sp.is_valid:
            sp = sp.buffer(0)
            if sp.geom_type != "Polygon":
                continue
            poly = np.asarray(sp.exterior.coords)[:-1]
        polys.append((pl, poly, sp, src))
    # 2. drop lines duplicating an area platform (Normanby)
    areas = [sp for pl, _, sp, src in polys if src == "area"]
    kept = []
    for pl, poly, sp, src in polys:
        if src == "line" and any(sp.intersection(a.buffer(3.0)).area > 0.5 * sp.area for a in areas):
            log(f"dropped line platform {pl.get('_id')} {pl.get('n')!r}: duplicates an area platform")
            continue
        kept.append((pl, poly, sp, src))
    # 3. station stops without a platform get one
    canopies = []
    for bi, b in enumerate(buildings):
        if b.get("k") == 8 or b.get("_st"):
            canopies.append((shapely.Polygon(ring(b["p"])).buffer(0), bi))
    have = [sp for _, _, sp, _ in kept]
    order = sorted(stops, key=lambda s: (s["code"] == "", s["name"]))
    for st in order:
        pt = shapely.Point(st["x"], st["y"])
        j = net.nearest(st["x"], st["y"], 15.0, net.k7)
        if j < 0:
            continue

        def side(x, y, j=j):
            return math.copysign(1.0, net.dir[j, 0] * (y - net.a[j, 1]) - net.dir[j, 1] * (x - net.a[j, 0]))

        s_stop = side(st["x"], st["y"])
        # a platform near the stop on its side of the busway already serves it
        if any(sp.distance(pt) < 3.0 or (sp.distance(pt) < 20.0 and side(sp.centroid.x, sp.centroid.y) == s_stop) for sp in have):
            continue
        res = synthesise(st, net, canopies)
        if res is None:
            continue
        poly, src = res
        sp = shapely.Polygon(poly)
        pl = {"n": st["name"], "r": st["code"], "p": None, "a": 1, "cv": 1, "_id": "gtfs"}
        kept.append((pl, poly, sp, "synth"))
        have.append(sp)
        log(f"synthesised platform for {st['name']!r} from {src}: {sp.area:.0f} m2")
    # 4. names and refs from the GTFS stop on the platform
    for pl, poly, sp, src in kept:
        if pl.get("n") and pl.get("r"):
            continue
        best = None
        for st in stops:
            d = sp.distance(shapely.Point(st["x"], st["y"]))
            if d > 12.0:
                continue
            if pl.get("r") and st["code"] and st["code"].upper() != pl["r"].upper():
                d += 20.0
            if best is None or d < best[0]:
                best = (d, st)
        if best is not None:
            st = best[1]
            if not pl.get("n"):
                pl["n"] = st["name"]
            if not pl.get("r"):
                pl["r"] = st["code"]
    for pl, poly, sp, src in kept:
        c = sp.centroid
        under_tag = pl.get("_under")
        j = host_segment(net, c.x, c.y, under_tag, pl.get("y", 0) > 0, maxd=25.0)
        rec = {"n": pl.get("n") or "", "r": pl.get("r") or "", "p": flat(np.asarray(shapely.Polygon(poly).exterior.coords)[:-1]), "a": 1}
        if pl.get("cv"):
            rec["cv"] = 1
        if pl.get("y"):
            rec["y"] = pl["y"]
        if j >= 0 and net.tun[j]:
            rec["u"] = 1
        rec["_src"] = src
        out.append(rec)
    return out


def tighten_stations(platforms: list[dict], net: BusNet) -> int:
    """Two-sided stations on a single two-lane busway whose facing platforms
    are further apart than STATION_W (OSM areas drawn 1-2 m back from the
    kerb: Normanby 15.9 m, Mater Hill 16.2 m, PA Hospital 15.8 m against
    14-15 m on the imagery, satellite review #1): both faces grow toward the
    busway, sharing the excess while each keeps a bay. Returns the count."""
    polys = [shapely.Polygon(ring(p["p"])).buffer(0) for p in platforms]
    info = []
    for pg in polys:
        c = pg.centroid
        j = net.nearest(c.x, c.y, 25.0, net.k7)
        if j < 0 or pg.is_empty or pg.geom_type != "Polygon":
            info.append(None)
            continue
        u = net.dir[j]
        nrm = np.array([-u[1], u[0]])
        v = np.asarray(pg.exterior.coords) - net.a[j]
        off = v @ nrm
        sgn = 1.0 if off.mean() > 0 else -1.0
        info.append((j, nrm, sgn, float(np.abs(off).min()) - net.hw[j], v @ u))
    n = 0
    done = set()
    for a in range(len(platforms)):
        for b in range(a + 1, len(platforms)):
            if info[a] is None or info[b] is None or a in done or b in done:
                continue
            ja, nrm, sa_, gap_a, ua = info[a]
            jb, _, _, gap_b, _ = info[b]
            if net.hw[ja] > 4.5 or net.hw[jb] > 4.5 or min(gap_a, gap_b) < 1.0:
                continue
            W = polys[a].distance(polys[b])
            if W <= STATION_W + 0.3 or W > STATION_W + 6.0:
                continue
            # opposite sides of a's busway, overlapping along it
            vb = np.asarray(polys[b].exterior.coords) - net.a[ja]
            if np.sign((vb @ nrm).mean()) == sa_:
                continue
            ub = vb @ net.dir[ja]
            if min(ua.max(), ub.max()) - max(ua.min(), ub.min()) < 5.0:
                continue
            excess = W - STATION_W
            da = min(0.5 * excess, gap_a - 0.5)
            db = min(excess - da, gap_b - 0.5)
            da = min(excess - db, gap_a - 0.5)
            for k, d in ((a, da), (b, db)):
                jk, nk, sk, _, _ = info[k]
                shift = -sk * nk * d
                grown = shapely.union(polys[k], shapely.affinity.translate(polys[k], shift[0], shift[1])).buffer(0.01).buffer(-0.01)
                if grown.geom_type != "Polygon":
                    continue
                grown = shapely.simplify(grown, 0.05)
                platforms[k]["p"] = flat(np.asarray(grown.exterior.coords)[:-1])
            log(f"station {platforms[a]['n']!r} / {platforms[b]['n']!r}: faces {W:.1f} m apart, grown {da:.1f} + {db:.1f} m to {STATION_W:.1f} m")
            done.update((a, b))
            n += 1
    return n


def drop_shelters(platforms: list[dict], buildings: list[dict]) -> list[dict]:
    """Buildings that duplicate a platform (its shelter or canopy mapped as a
    building, extruded from the ground as a solid block over the platform:
    Herston, Stones Corner, PA Hospital, M2 review #13): the platform is marked
    covered and draws its own canopy instead. Dropped are
    - any building mostly (70 %) on a platform,
    - shelters, station buildings and station outlines (amenity=bus_station:
      Stones Corner's duplicates its two platform roofs) 15 % on a platform,
    - generic buildings (building=yes) 60 % on a platform (2 m around it),
    - upper-level buildings (layer >= 1, no min_height) 30 % on one: they
      stand on the viaduct or deck, not on the street under it."""
    if not platforms:
        return buildings
    pp = [shapely.Polygon(ring(p["p"])).buffer(0) for p in platforms]
    tree = shapely.STRtree(pp)
    keep = []
    dropped = []
    for b in buildings:
        if b.get("_br"):  # bridge outlines: bridge_bases
            keep.append(b)
            continue
        poly = shapely.Polygon(ring(b["p"])).buffer(0)
        if b.get("k") == 8:
            # a roof that is the platform's own canopy (QUT KG platforms are
            # mapped as building=roof too, M2 #17): platforms.ts draws it
            hit = [int(i) for i in tree.query(poly, predicate="intersects")] if not poly.is_empty and poly.area <= 2500 else []
            if hit and sum(poly.intersection(pp[i].buffer(1.0)).area for i in hit) >= 0.7 * poly.area:
                dropped.append((b.get("_id"), "roof = platform canopy", round(poly.area)))
                for i in hit:
                    platforms[i]["cv"] = 1
                continue
            keep.append(b)
            continue
        if poly.is_empty or poly.area > (5000 if b.get("_sh") else 2500):
            keep.append(b)
            continue
        hit = [int(i) for i in tree.query(poly.buffer(3.0), predicate="intersects")]
        if not hit:
            keep.append(b)
            continue
        cov1 = sum(poly.intersection(pp[i].buffer(1.0)).area for i in hit) / poly.area
        cov2 = sum(poly.intersection(pp[i].buffer(2.0)).area for i in hit) / poly.area
        why = None
        if cov1 >= 0.7 and poly.area <= 2500:
            why = "on a platform"
        elif (b.get("_sh") or b.get("_st")) and cov2 >= 0.15:
            why = "shelter/station building over a platform"
        elif not b.get("k") and cov2 >= 0.6:
            why = "generic building over a platform"
        elif b.get("_up") and cov2 >= 0.3:
            why = "upper-level building at a platform"
        if why is None:
            keep.append(b)
            continue
        dropped.append((b.get("_id"), why, round(poly.area)))
        for i in hit:
            if poly.distance(pp[i]) < 2.0:
                platforms[i]["cv"] = 1
    log(f"dropped {len(dropped)} buildings duplicating platforms: {dropped}")
    return keep


# ---------------------------------------------------------------------------
# Kerbs and bays


def kerb_chains(poly: np.ndarray, net: BusNet):
    """Kerb polylines of a platform (as platforms.ts finds them), oriented with
    the platform on the left of travel. Returns [(pts, (ox, oy))]."""
    n = len(poly)
    area = 0.5 * float(np.sum(poly[:, 0] * np.roll(poly[:, 1], -1) - np.roll(poly[:, 0], -1) * poly[:, 1]))
    ccw = area > 0
    segs = []
    for i in range(n):
        a = poly[i]
        b = poly[(i + 1) % n]
        L = float(np.hypot(*(b - a)))
        if L < 2.0:
            continue
        e = (b - a) / L
        o = np.array([e[1], -e[0]]) if ccw else np.array([-e[1], e[0]])
        m = 0.5 * (a + b)
        d, t, fx, fy = net.project(m[0], m[1])
        j = int(np.argmin(d))
        if d[j] > KERB_SEARCH:
            continue
        align = abs(float(net.dir[j] @ e))
        facing = (fx[j] - m[0]) * o[0] + (fy[j] - m[1]) * o[1]
        if align > 0.85 and facing > -0.5:
            segs.append((a, b, o))
    chains = []
    used = [False] * len(segs)
    for k in range(len(segs)):
        if used[k]:
            continue
        used[k] = True
        pts = [segs[k][0], segs[k][1]]
        o = segs[k][2].copy()
        grew = True
        while grew:
            grew = False
            for m in range(len(segs)):
                if used[m]:
                    continue
                a, b, om = segs[m]
                if np.hypot(*(a - pts[-1])) < 0.05:
                    pts.append(b)
                elif np.hypot(*(b - pts[0])) < 0.05:
                    pts.insert(0, a)
                else:
                    continue
                o += om
                used[m] = True
                grew = True
        o /= max(1e-9, float(np.hypot(*o)))
        t = np.array([-o[1], o[0]])
        P = np.asarray(pts)
        if float((P[-1] - P[0]) @ t) < 0:
            P = P[::-1]
        chains.append((P, o))
    return chains


def smoothstep(u):
    u = np.clip(u, 0.0, 1.0)
    return u * u * (3 - 2 * u)


def _conflicts(bxy: np.ndarray, bz: np.ndarray, half: float, net: BusNet, chain_ids, placed) -> np.ndarray:
    """Bay samples whose carriageway would overlap another bus road (not the
    host chain) or another kerb's bay at about the same level: inside an
    underground station (Queen St, KGS) the bays would otherwise cross the
    other lanes, a level crossing in a tunnel (audit)."""
    other = ~np.isin(net.rid, list(chain_ids))
    bad = np.zeros(len(bxy), bool)
    for m, (x, y) in enumerate(bxy):
        d, t, _, _ = net.project(x, y)
        zz = net.za + (net.zb - net.za) * t
        level = np.abs(zz - bz[m]) < 3.0
        if np.any(other & (d < net.hw + half - 0.3) & level):
            bad[m] = True
            continue
        # a bay merges into its own busway but stays on its side of the
        # centreline (KGS: the second strip crossed the INB's centreline)
        if np.any(~other & (d < 1.05) & level):  # samples are 2 m apart
            bad[m] = True
            continue
        host = ~other & level
        jh = int(np.argmin(np.where(host, d, np.inf))) if host.any() else -1
        for qxy, qz, qh in placed:
            dd = np.hypot(qxy[:, 0] - x, qxy[:, 1] - y)
            k = int(np.argmin(dd))
            if dd[k] < qh + half - 0.3 and abs(float(qz[k]) - float(bz[m])) < 3.0:
                # the tapers of bays on opposite kerbs meet inside the busway they
                # both merge into, under its asphalt: no conflict (Normanby)
                if jh >= 0:
                    ux, uy = net.dir[jh]
                    ax_, ay_ = net.a[jh]
                    c1 = ux * (y - ay_) - uy * (x - ax_)
                    c2 = ux * (qxy[k, 1] - ay_) - uy * (qxy[k, 0] - ax_)
                    lo, hi = max(c1 - half, c2 - qh), min(c1 + half, c2 + qh)
                    if hi <= lo or (lo > -net.hw[jh] + 0.2 and hi < net.hw[jh] - 0.2):
                        continue
                bad[m] = True
                break
    return bad


def bays_for_kerb(P: np.ndarray, o: np.ndarray, pl: dict, net: BusNet, simplify3d, placed=None) -> tuple[list[dict], list]:
    """Bay carriageways between one kerb and its busway. placed: (xy, z, half
    width) samples of the bays of earlier kerbs, which these must not overlap."""
    placed = [] if placed is None else placed
    line = shapely.LineString(P)
    L = line.length
    if L < 4:
        return [], []
    ss = np.linspace(0, L, max(2, int(L / STEP) + 1))
    K = np.asarray([line.interpolate(s).coords[0] for s in ss])
    t = np.array([-o[1], o[0]])
    under = True if pl.get("u") else None
    raised = pl.get("y", 0) > 0
    mid = K[len(K) // 2]
    j = host_segment(net, mid[0], mid[1], under, raised, maxd=KERB_SEARCH + 2, tangent=t, side=o)
    if j < 0:
        return [], []
    rid = int(net.rid[j])
    seg = int(net.seg[j])
    p = net.P[rid]
    at = float(np.hypot(*np.diff(p[: seg + 1], axis=0).T).sum()) + float((mid - net.a[j]) @ net.dir[j])
    reach = 0.5 * L + TAPER_MAX + 20.0
    xy, z, segr, at = net.road_chain(rid, reach, reach, at)
    ch = Chain(xy, z, segr, net.roads)
    s, e = ch.locate(K)
    sgn = 1.0 if np.median(e) >= 0 else -1.0
    e = e * sgn
    # chain samples must be on the platform side and aligned
    if np.mean(e > 0) < 0.8:
        return [], []
    _, _, _, hw_k = ch.at(s)
    gap = e - hw_k
    if float(np.max(gap)) < BAY_MIN_GAP:
        return [], []
    order = np.argsort(s)
    s, e, hw_k = s[order], e[order], hw_k[order]
    reverse = bool(np.median(np.diff(ch.locate(K[[0, -1]])[0])) < 0)
    # outer edge along the platform: a running max over 4 m keeps the slab edge covered
    E = e + BAY_UNDER
    E = np.asarray([E[max(0, i - 2): i + 3].max() for i in range(len(E))])
    sa, sb = float(s[0]), float(s[-1])
    hw0 = float(np.min(hw_k))
    inner = hw0 - BAY_OVERLAP
    W = float(E.max()) - inner
    nstrip = max(1, int(math.ceil(W / min(BAY_MAX_W, 2 * hw0 - 0.5))))
    Wk = W / nstrip
    Ea, Eb = float(E[0]), float(E[-1])
    ga, gb = Ea - float(hw_k[0]), Eb - float(hw_k[-1])
    La = min(float(np.clip(TAPER_PER_M * ga, TAPER_MIN, TAPER_MAX)), sa)
    Lb = min(float(np.clip(TAPER_PER_M * gb, TAPER_MIN, TAPER_MAX)), ch.length - sb)

    def outer(sv):
        sv = np.asarray(sv, dtype=np.float64)
        _, _, _, hw = ch.at(sv)
        mid_e = np.interp(sv, s, E)
        up = Ea - (Ea - hw) * smoothstep((sa - sv) / max(La, 1e-6))
        dn = Eb - (Eb - hw) * smoothstep((sv - sb) / max(Lb, 1e-6))
        return np.where(sv < sa, up, np.where(sv > sb, dn, mid_e)), hw

    sv = np.arange(sa - La, sb + Lb + 1e-6, STEP)
    if len(sv) < 2:
        return [], []
    sv[-1] = min(sv[-1], ch.length)
    Ev, hwv = outer(sv)
    pos, zv, nv, _ = ch.at(sv)
    out = []
    burn = []
    mine = []
    chain_ids = {int(r) for r in ch.segr}
    for k in range(nstrip):
        edge = Ev - k * Wk  # this strip's outer edge
        alive = edge > hwv + 0.05
        # inside the platform section every strip runs
        alive |= (sv >= sa) & (sv <= sb)
        idx = np.flatnonzero(alive)
        if len(idx) < 2:
            continue
        # contiguous run around the platform
        runs = np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1)
        run = max(runs, key=len)
        i0, i1 = int(run[0]), int(run[-1])
        # extend one sample each way so the strip ends inside the busway
        i0 = max(0, i0 - 1)
        i1 = min(len(sv) - 1, i1 + 1)
        # stop short of other lanes and other kerbs' bays
        cc = edge[i0 : i1 + 1] - 0.5 * Wk
        bad = _conflicts(pos[i0 : i1 + 1] + nv[i0 : i1 + 1] * (sgn * cc)[:, None], zv[i0 : i1 + 1], 0.5 * Wk, net, chain_ids, placed)
        if bad.any():
            free = np.flatnonzero(~bad) + i0
            if len(free) < 2:
                continue
            runs = np.split(free, np.flatnonzero(np.diff(free) > 1) + 1)
            mid_i = int(np.argmin(np.abs(sv - 0.5 * (sa + sb))))
            run = min(runs, key=lambda r_: (0 if r_[0] <= mid_i <= r_[-1] else 1, -len(r_)))
            if len(run) < 5:
                continue
            i0, i1 = int(run[0]), int(run[-1])
        sl = slice(i0, i1 + 1)
        c = edge[sl] - 0.5 * Wk
        bxy = pos[sl] + nv[sl] * (sgn * c)[:, None]
        bz = zv[sl]
        mine.append((bxy, bz, 0.5 * Wk))
        flags = [ch.flags_at(v) for v in sv[sl]]
        # split where the busway changes structure
        cut = [0] + [m for m in range(1, len(flags)) if flags[m] != flags[m - 1]] + [len(flags)]
        for a_, b_ in zip(cut[:-1], cut[1:]):
            lo = max(0, a_ - (1 if a_ > 0 else 0))
            pxy = bxy[lo:b_]
            pz = bz[lo:b_]
            if len(pxy) < 2:
                continue
            if reverse:
                pxy, pz = pxy[::-1], pz[::-1]
            keep = simplify3d(pxy, pz, 0.05, 0.05)
            pxy, pz = pxy[keep], pz[keep]
            host = net.roads[int(ch.segr[int(ch.seg_at(float(sv[sl][a_])))])]
            b_f, t_f, y_f, tb_f = flags[a_]
            rec = {"k": 7, "w": round(Wk + 0.2, 1), "l": 1, "p": flat(pxy), "z": [q(v) for v in pz], "o": 1, "bus": 1, "bay": 1}
            if "n" in host:
                rec["n"] = host["n"]
            if "ms" in host:
                rec["ms"] = host["ms"]
            if b_f:
                rec["b"] = 1
            if t_f:
                rec["t"] = 1
                # (in a tunnel boxed end to end, elevation.boxed_tunnels: so is the bay beside it, Mater Hill)
                if tb_f:
                    rec["tb"] = 1
            if y_f:
                rec["y"] = y_f
            out.append(rec)
            if not b_f and not t_f:
                burn.append((pxy, pz, 0.5 * (Wk + 0.2) + 0.5))
    placed.extend(mine)
    # platform pad: the slab footprint at the busway height, burned flat
    if not net.bri[j] and not net.tun[j]:
        kxy = K[order] - o * 2.0
        _, kz, _, _ = ch.at(s)
        burn.append((kxy, kz, 2.5))
    return out, burn


def inherit_maxspeed(roads: list[dict]) -> int:
    """Bus ways with no maxspeed tag take the limit of the road they run beside
    on the same structure (Victoria Bridge's one-way bus lane #16169 beside the
    50 km/h bridge carriageway, 222 review #14), so the HUD does not fall back
    to the 80 km/h busway default there."""
    segs_a, segs_b, rid = [], [], []
    for i, r in enumerate(roads):
        if "ms" not in r:
            continue
        p = ring(r["p"])
        segs_a.append(p[:-1])
        segs_b.append(p[1:])
        rid.append(np.full(len(p) - 1, i))
    if not segs_a:
        return 0
    A = np.concatenate(segs_a)
    B = np.concatenate(segs_b)
    R = np.concatenate(rid)
    tree = shapely.STRtree(shapely.linestrings(np.stack([A, B], 1)))
    n = 0
    for i, r in enumerate(roads):
        if "ms" in r or not (r.get("bus") or r["k"] == 7):
            continue
        p = ring(r["p"])
        z = np.asarray(r["z"], dtype=np.float64) * 0.1
        L = float(np.hypot(*np.diff(p, axis=0).T).sum())
        if L < 5:
            continue
        line = shapely.LineString(p)
        votes: dict[int, float] = collections.Counter()
        for f in (0.25, 0.5, 0.75):
            pt = line.interpolate(f, normalized=True)
            k = min(len(p) - 2, max(0, int(np.searchsorted(np.cumsum(np.hypot(*np.diff(p, axis=0).T)), f * L))))
            d = p[k + 1] - p[k]
            d = d / max(1e-9, float(np.hypot(*d)))
            zi = float(z[k])
            for j in tree.query(pt, predicate="dwithin", distance=0.5 * r["w"] + 7.0):
                o = roads[int(R[j])]
                if bool(o.get("b")) != bool(r.get("b")) or bool(o.get("t")) != bool(r.get("t")):
                    continue
                e = B[j] - A[j]
                e = e / max(1e-9, float(np.hypot(*e)))
                if abs(float(d @ e)) < 0.9:
                    continue
                oz = np.asarray(o["z"], dtype=np.float64) * 0.1
                if abs(float(np.median(oz)) - zi) > 3.0:
                    continue
                votes[int(o["ms"])] += 1
        if votes:
            r["ms"] = max(votes.items(), key=lambda kv: kv[1])[0]
            n += 1
    # still untagged: the limit of the bus ways joined at its ends (the INB
    # stub #3854 between a 50 and the 40 km/h tunnel, M2 review #11): the lower
    # of the two ends, or the one end's for a way under 150 m
    ends: dict[tuple[int, int], list[int]] = collections.defaultdict(list)
    for i, r in enumerate(roads):
        if "ms" in r and (r.get("bus") or r["k"] == 7):
            ends[(r["p"][0], r["p"][1])].append(int(r["ms"]))
            ends[(r["p"][-2], r["p"][-1])].append(int(r["ms"]))
    for i, r in enumerate(roads):
        if "ms" in r or not (r.get("bus") or r["k"] == 7):
            continue
        v0 = ends.get((r["p"][0], r["p"][1]), [])
        v1 = ends.get((r["p"][-2], r["p"][-1]), [])
        L = float(np.hypot(*np.diff(ring(r["p"]), axis=0).T).sum())
        if v0 and v1:
            r["ms"] = min(min(v0), min(v1))
        elif (v0 or v1) and L < 150.0:
            r["ms"] = min(v0 or v1)
        else:
            continue
        n += 1
    # the rest: the limit of the nearest tagged bus way along the bus network
    # (no busway in OSM here is signed above 60, so an untagged section of the
    # SE or Eastern Busway between 50 and 60 km/h sections should not read the
    # HUD's 80 km/h busway default: Boggo Road, PA Hospital, M2 review #11).
    # Bus-station and layover limits under 40 do not spread.
    node_ways: dict[tuple[int, int], list[int]] = collections.defaultdict(list)
    bus = [i for i, r in enumerate(roads) if (r.get("bus") or r["k"] == 7) and not r.get("bay")]
    length = {}
    for i in bus:
        p = roads[i]["p"]
        node_ways[(p[0], p[1])].append(i)
        node_ways[(p[-2], p[-1])].append(i)
        length[i] = float(np.hypot(*np.diff(ring(p), axis=0).T).sum())
    heap = []
    for i in bus:
        r = roads[i]
        if "ms" in r and int(r["ms"]) >= 40:
            p = r["p"]
            heap.append((0.0, int(r["ms"]), (p[0], p[1])))
            heap.append((0.0, int(r["ms"]), (p[-2], p[-1])))
    heapq.heapify(heap)
    reach: dict[tuple[int, int], tuple[float, int]] = {}
    while heap:
        d, ms, e = heapq.heappop(heap)
        if e in reach:
            continue
        reach[e] = (d, ms)
        for i in node_ways[e]:
            p = roads[i]["p"]
            if "ms" in roads[i]:
                continue
            f = (p[-2], p[-1]) if (p[0], p[1]) == e else (p[0], p[1])
            if f not in reach:
                heapq.heappush(heap, (d + length[i], ms, f))
    for i in bus:
        r = roads[i]
        if "ms" in r:
            continue
        p = r["p"]
        cand = [reach[e] for e in ((p[0], p[1]), (p[-2], p[-1])) if e in reach]
        if cand:
            r["ms"] = min(cand)[1]
            n += 1
    return n


def build(roads: list[dict], platforms: list[dict], buildings: list[dict]):
    """Normalise platforms, add bay roads. Returns (platforms, buildings, bays, burn segments)."""
    import elevation  # simplify3d

    nms = inherit_maxspeed(roads)
    log(f"{nms} untagged bus ways take the speed limit of the road beside them or the bus ways they join")
    net = BusNet(roads)
    stops = gtfs_station_stops()
    plats = normalise_platforms(platforms, net, buildings, stops)
    nt = tighten_stations(plats, net)
    buildings = drop_shelters(plats, buildings)
    bays: list[dict] = []
    burn = []
    nk = 0
    placed: list = []
    for pl in plats:
        poly = ring(pl["p"])
        for P, o in kerb_chains(poly, net):
            nk += 1
            recs, segs = bays_for_kerb(P, o, pl, net, elevation.simplify3d, placed)
            bays.extend(recs)
            burn.extend(segs)
    for pl in plats:
        pl.pop("_src", None)
    log(f"{len(plats)} platforms ({nt} station pairs narrowed), {nk} kerbs, {len(bays)} bay carriageways")
    return plats, buildings, bays, burn


# ---------------------------------------------------------------------------
# Canopy roofs


BRIDGE_CLEAR_ROAD = 5.3  # m: footbridge soffit above a road or busway under it
BRIDGE_CLEAR_RAIL = 6.5  # m: ... above rail (overhead wires)


def bridge_bases(buildings: list[dict], roads: list[dict], rail: list[dict]) -> list[dict]:
    """Bridge outlines mapped as buildings (building=bridge: footbridges and
    enclosed walkways, the PA Hospital footbridge across the busway, M2 #13):
    min height so the soffit clears the highest road or track under the
    outline, the top a walkway above it. Bridge outlines with nothing under
    them are dropped (their height is unknown). Runs after building_bases."""
    lines = []
    for r in roads:
        if r.get("t") or r["k"] > 8:
            continue
        lines.append((ring(r["p"]), np.asarray(r["z"], dtype=np.float64) * 0.1, 0.5 * float(r.get("w", 6)), BRIDGE_CLEAR_ROAD))
    for r in rail:
        if r.get("t"):
            continue
        lines.append((ring(r["p"]), np.asarray(r["z"], dtype=np.float64) * 0.1, 2.0, BRIDGE_CLEAR_RAIL))
    if not any(b.get("_br") for b in buildings):
        return buildings
    geoms = [shapely.LineString(p) for p, _, _, _ in lines]
    tree = shapely.STRtree(geoms)
    out = []
    lifted = []
    dropped = []
    for b in buildings:
        if not b.get("_br"):
            out.append(b)
            continue
        poly = shapely.Polygon(ring(b["p"])).buffer(0)
        need = -np.inf
        for i in tree.query(poly, predicate="dwithin", distance=8.0):
            p, z, hw, clr = lines[int(i)]
            if not poly.intersects(geoms[int(i)].buffer(hw)):
                continue
            # the road's height where it is under the outline, sampled every 2 m
            L = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])
            s = np.arange(0.0, L[-1] + 0.01, 2.0)
            xs, ys, zs = np.interp(s, L, p[:, 0]), np.interp(s, L, p[:, 1]), np.interp(s, L, z)
            inside = shapely.dwithin(poly, shapely.points(np.stack([xs, ys], 1)), hw)
            if inside.any():
                need = max(need, float(zs[inside].max()) + clr)
        if not np.isfinite(need):
            dropped.append(b.get("_id"))
            continue
        base = 0.1 * float(b["z"])
        m = max(need - base, float(b.get("m", 0)))
        nb = dict(b)
        nb["m"] = round(m, 1)
        nb["h"] = round(max(float(b["h"]), m + 3.2) if float(b["h"]) > m + 2.0 else m + float(b["h"]), 1)
        out.append(nb)
        lifted.append((b.get("_id"), round(m, 1)))
    log(f"bridge outlines: {len(lifted)} lifted over the roads under them {lifted}, {len(dropped)} with nothing under them dropped")
    return out


def roof_bases(buildings: list[dict], roads: list[dict], platforms: list[dict]) -> list[dict]:
    """Canopy roofs (kind 8) over a busway or a platform: base on the road under
    them, top CANOPY_CLEAR above it; long roofs on a grade in sections.
    Returns the new building list (sections replace their roof)."""
    net = BusNet(roads)
    segs = shapely.linestrings(np.stack([net.a, net.b], 1))
    road_polys = shapely.buffer(segs, net.hw + 0.5, cap_style="flat")
    tree = shapely.STRtree(road_polys)
    zmax = np.maximum(net.za, net.zb)
    plat_polys = [shapely.Polygon(ring(p["p"])).buffer(0) for p in platforms]
    out = []
    n_fix = n_split = 0
    for b in buildings:
        if b.get("k") != 8:
            out.append(b)
            continue
        poly = shapely.Polygon(ring(b["p"])).buffer(0)
        if poly.is_empty or poly.area > 30000 or float(b["h"]) > 8:  # stadium roofs and the like keep theirs
            out.append(b)
            continue
        hits = [int(i) for i in tree.query(poly, predicate="intersects") if not net.tun[int(i)]]
        pl_hits = [i for i, pp in enumerate(plat_polys) if pp.intersects(poly)]
        if not hits and not pl_hits:
            out.append(b)
            continue
        # roads under the roof, and platforms (their busway height, from the nearest bus road)
        pieces = [poly]
        if hits:
            k = max(hits, key=lambda i: road_polys[i].intersection(poly).area)
            u = net.dir[k]
            pts = np.asarray(poly.exterior.coords)
            proj = pts @ u
            span = float(proj.max() - proj.min())
            if span > 1.5 * CANOPY_SECTION:
                nsec = int(math.ceil(span / CANOPY_SECTION))
                edges = np.linspace(proj.min(), proj.max(), nsec + 1)
                v = np.array([-u[1], u[0]])
                w = float((pts @ v).max() - (pts @ v).min()) + 10
                c0 = float((pts @ v).min()) - 5
                pieces = []
                for a_, b_ in zip(edges[:-1], edges[1:]):
                    rect = shapely.Polygon([u * a_ + v * c0, u * b_ + v * c0, u * b_ + v * (c0 + w), u * a_ + v * (c0 + w)])
                    g = poly.intersection(rect)
                    for gg in getattr(g, "geoms", [g]):
                        if gg.geom_type == "Polygon" and gg.area > 4:
                            pieces.append(gg)
                n_split += 1
        bases: list[float | None] = []
        for g in pieces:
            zs = []
            for i in tree.query(g, predicate="intersects"):
                i = int(i)
                if net.tun[i]:
                    continue
                # road height inside the piece
                inter = road_polys[i].intersection(g)
                if inter.is_empty:
                    continue
                c = inter.centroid
                tt = float(np.clip((np.array([c.x, c.y]) - net.a[i]) @ net.dir[i] / net.len[i], 0, 1))
                zs.append(float(net.za[i] + (net.zb[i] - net.za[i]) * tt))
            for pi in pl_hits:
                if plat_polys[pi].intersects(g):
                    c = plat_polys[pi].intersection(g).centroid
                    jj = host_segment(net, c.x, c.y, None, False, maxd=25.0)
                    if jj >= 0:
                        zs.append(float(max(net.za[jj], net.zb[jj])) + 0.3)
            bases.append(max(zs) if zs else None)
        known = [k for k, v in enumerate(bases) if v is not None]
        if not known:
            out.append(b)
            continue
        for k, g in enumerate(pieces):
            base = bases[k]
            if base is None:  # a section off the road: its nearest neighbour's base
                base = bases[min(known, key=lambda m: abs(m - k))]
            nb = dict(b)
            if g is not poly:
                nb["p"] = flat(np.asarray(shapely.Polygon(g.exterior).simplify(0.2).exterior.coords)[:-1])
                nb.pop("n", None)
            nb["z"] = q(base)
            nb["h"] = round(float(b["h"]) if float(b["h"]) > 6 else CANOPY_CLEAR, 1)
            nb.pop("m", None)
            out.append(nb)
            n_fix += 1
    log(f"canopy roofs over busways/platforms re-based: {n_fix} pieces ({n_split} roofs split along grades)")
    return out
