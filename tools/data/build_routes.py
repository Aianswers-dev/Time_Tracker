"""Extract TransLink bus routes that run through the inner city.

Input:  tools/data/raw/SEQ_GTFS.zip (TransLink SEQ GTFS, unpacked to raw/gtfs),
        public/data/roads.json + terrain.bin from build_osm.py
Output: public/data/routes.json

For each route and direction we keep the most common shape, clip it to the
longest stretch inside the map, and attach the stops served along it. Each
route vertex gets a height "z" (decimetres AHD) by matching the route onto the
solved roads at a continuous height (elevation.RoadHeights), so a route
through the busway tunnels stays underground and one on a viaduct stays up;
each stop gets the route height at its position.
"""

import collections
import csv
import json
import os
import sys
import zipfile

import numpy as np
from shapely.geometry import LineString, Point

import build_terrain
import elevation

from common import OUT, RAW, in_bbox, project, q

GTFS_ZIP = os.path.join(RAW, "SEQ_GTFS.zip")
GTFS = os.path.join(RAW, "gtfs")
MIN_LEN = 1200.0  # metres of the route that must be inside the map
INNER_PAD = -0.001  # shrink bbox slightly so routes start on mapped roads


def read(name):
    with open(os.path.join(GTFS, name), newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


def secs(hms: str) -> int:
    h, m, s = (int(v) for v in hms.split(":"))
    return h * 3600 + m * 60 + s


def main():
    if not os.path.exists(os.path.join(GTFS, "shapes.txt")):
        with zipfile.ZipFile(GTFS_ZIP) as z:
            z.extractall(GTFS)

    routes = {
        r["route_id"]: r
        for r in read("routes.txt")
        if r["route_type"] == "3" and "rail replacement" not in r["route_long_name"].lower()
    }
    print("bus route ids", len(routes), file=sys.stderr)

    # (short_name, direction) -> Counter(shape_id), shape -> headsign counts, shape -> trips
    shape_count: dict[tuple, collections.Counter] = collections.defaultdict(collections.Counter)
    shape_headsign: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    shape_trip: dict[str, str] = {}
    shape_route: dict[str, str] = {}
    shape_op: dict[str, str] = {}
    for t in read("trips.txt"):
        r = routes.get(t["route_id"])
        if not r:
            continue
        key = (r["route_short_name"], t["direction_id"])
        sid = t["shape_id"]
        shape_count[key][sid] += 1
        shape_headsign[sid][t["trip_headsign"]] += 1
        shape_trip.setdefault(sid, t["trip_id"])
        shape_route[sid] = t["route_id"]
        shape_op[sid] = t["service_id"].split(" ")[0]

    chosen = {key: c.most_common(1)[0] for key, c in shape_count.items()}
    wanted_shapes = {sid for sid, _ in chosen.values()}
    print("route-directions", len(chosen), file=sys.stderr)

    shapes: dict[str, list] = collections.defaultdict(list)
    for s in read("shapes.txt"):
        if s["shape_id"] in wanted_shapes:
            shapes[s["shape_id"]].append((int(s["shape_pt_sequence"]), float(s["shape_pt_lon"]), float(s["shape_pt_lat"])))

    # Clip each shape to its longest run inside the map.
    clipped: dict[str, LineString] = {}
    for sid, pts in shapes.items():
        pts.sort()
        best: list = []
        run: list = []
        for _, lon, lat in pts:
            if in_bbox(lon, lat, INNER_PAD):
                run.append(project(lon, lat))
            else:
                if len(run) > len(best):
                    best = run
                run = []
        if len(run) > len(best):
            best = run
        # Drop consecutive duplicates.
        dedup = [best[0]] if best else []
        for p in best[1:]:
            if abs(p[0] - dedup[-1][0]) > 0.05 or abs(p[1] - dedup[-1][1]) > 0.05:
                dedup.append(p)
        if len(dedup) < 2:
            continue
        line = LineString(dedup)
        if line.length >= MIN_LEN:
            clipped[sid] = line
    print("shapes inside map", len(clipped), file=sys.stderr)

    trip_shape = {shape_trip[sid]: sid for sid in clipped}
    trip_stops: dict[str, list] = collections.defaultdict(list)
    for st in read("stop_times.txt"):
        tid = st["trip_id"]
        if tid in trip_shape:
            trip_stops[tid].append((int(st["stop_sequence"]), st["stop_id"], st["arrival_time"]))

    stops_all = {s["stop_id"]: s for s in read("stops.txt")}
    stop_index: dict[str, int] = {}
    stops_out: list[dict] = []

    def stop_idx(sid: str) -> int:
        if sid not in stop_index:
            s = stops_all[sid]
            x, y = project(float(s["stop_lon"]), float(s["stop_lat"]))
            stop_index[sid] = len(stops_out)
            stops_out.append({"n": s["stop_name"].strip(), "c": s["stop_code"], "x": q(x), "y": q(y)})
        return stop_index[sid]

    with open(os.path.join(OUT, "roads.json")) as f:
        heights = elevation.RoadHeights(json.load(f)["roads"])
    inner, outer, _ = build_terrain.read_terrain()
    ground = build_terrain.ground_sampler(inner, outer)
    stop_z: dict[int, list[float]] = collections.defaultdict(list)
    off_road = []

    out = []
    for (short, direction), (sid, freq) in sorted(chosen.items(), key=lambda kv: (kv[0][0].zfill(6), kv[0][1])):
        line = clipped.get(sid)
        if line is None:
            continue
        r = routes[shape_route[sid]]
        trip = shape_trip[sid]
        seq = sorted(trip_stops.get(trip, []))
        stops = []
        last_s = -1.0
        for _, stop_id, _arr in seq:
            s = stops_all.get(stop_id)
            if not s:
                continue
            lon, lat = float(s["stop_lon"]), float(s["stop_lat"])
            if not in_bbox(lon, lat, INNER_PAD):
                continue
            pt = Point(project(lon, lat))
            if line.distance(pt) > 40:
                continue
            d = line.project(pt)
            if d < last_s - 5:  # loops can revisit, keep monotonic
                continue
            last_s = max(last_s, d)
            stops.append([stop_idx(stop_id), q(d), secs(_arr)])
        if stops:
            t0 = stops[0][2]
            for st in stops:
                st[2] -= t0
        dense = elevation.densify(np.asarray(line.coords), 4.0)
        z, off = heights.match(dense, ground)
        off_road.append(off)
        cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(dense, axis=0).T))])
        for st in stops:
            stop_z[st[0]].append(float(np.interp(st[1] * 0.1, cum, z)))
        keep = elevation.simplify3d(dense, z, 0.4, elevation.ROUTE_ZTOL)
        flat = elevation.flat(dense[keep])
        zq = [q(v) for v in z[keep]]
        out.append(
            {
                "id": short,
                "name": r["route_long_name"],
                "dir": int(direction or 0),
                "headsign": shape_headsign[sid].most_common(1)[0][0],
                "color": "#" + (r["route_color"] or "E463A4"),
                "text": "#" + (r["route_text_color"] or "FFFFFF"),
                "op": shape_op.get(sid, ""),
                "trips": freq,
                "len": round(line.length),
                "p": flat,
                "z": zq,
                "stops": stops,
            }
        )

    for k, zs in stop_z.items():
        stops_out[k]["z"] = q(float(np.median(zs)))
    print(f"route heights: {100 * float(np.mean(off_road)):.1f}% of samples off the mapped roads", file=sys.stderr)

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "routes.json")
    with open(path, "w") as f:
        json.dump({"scale": 0.1, "stops": stops_out, "routes": out}, f, separators=(",", ":"))
    print("routes", len(out), "stops", len(stops_out), os.path.getsize(path) // 1024, "KB", file=sys.stderr)


if __name__ == "__main__":
    main()
