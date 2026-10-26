"""Road and rail heights: grade separation on top of the terrain.

build_osm.py collects every road and rail way at full resolution with its
OSM node ids (`Line`), then `build()`:

  * cleans the terrain (build_terrain.clean) with the fresh water, building
    and wood polygons,
  * `solve()`s a height in metres AHD for every vertex of the network,
  * clips and simplifies each way (in plan AND in height, so a straight bridge
    keeps its crest) into the output records and adds their per-vertex "z",
  * burns the at-grade roads and rail into the terrain (cuttings and
    embankments) and writes terrain.bin / terrain.json,
  * gives every building its base height "z".

The solve:

  1. Graph. Ways are joined where they share an OSM node (never by
     proximity), and densified to <= MAX_SEG metre edges so the terrain is
     sampled finely and long straight ways can bend vertically. Junctions are
     one graph node, so connected ways always agree on its height.
  2. Hard bounds. Bridges clear what they cross without a shared node
     (roads, rail, water; the river bridges use real deck heights), tunnels
     stay PORTAL_DEPTH below the ground at a portal and COVER further in (far
     deeper under the river), and ways on a higher `layer` clear the ones
     below. Each crossing has exactly one "mover" (the bridge, else the
     tunnel, else the higher layer).
  3. The bounds are spread through the network with the per-class grade caps
     (a Dijkstra in "grade metres"), so untagged ramps and cuttings leading
     to a bridge or portal rise or fall in time.
  4. A sparse bounded least-squares solve: ordinary nodes follow the ground,
     every way resists vertical bending (smooth vertical curves), bridge and
     tunnel interiors only bend. Crossing bounds are recomputed from the new
     heights and the solve repeats.
  5. Exact grade caps: the midpoint of the lower and upper Lipschitz
     envelopes in the grade metric. It changes nothing that already meets
     the caps and keeps every bound.

Output vertices take their heights from the dense full-resolution solve.
`RoadHeights` matches other geometry (bus routes) onto the solved roads.
"""

from __future__ import annotations

import math
import sys
import time
from dataclasses import dataclass, field

import numpy as np
import shapely
from scipy import ndimage, sparse
from scipy.sparse import csgraph
from scipy.sparse.linalg import splu

RAIL = 9  # pseudo road kind for railway lines

# Grade caps (rise / run) per road kind: residential ~12 %, arterials ~8 %,
# motorways and busways ~6 %, rail 3.5 %; service roads (lanes, car-park
# ramps) 15 %.
CAP = {0: 0.06, 1: 0.07, 2: 0.08, 3: 0.08, 4: 0.10, 5: 0.12, 6: 0.15, 7: 0.06, 8: 0.12, RAIL: 0.035}
LINK_CAP = 0.08  # *_link ramps
# Vertical smoothing length per kind (metres): how far a bump in the ground is averaged out.
ELL = {0: 45.0, 1: 40.0, 2: 32.0, 3: 30.0, 4: 26.0, 5: 20.0, 6: 18.0, 7: 40.0, 8: 18.0, RAIL: 70.0}
MINOR = (6, 8)  # service / pedestrian: tunnels are car-park style ramps that start at grade

MAX_SEG = 10.0  # densify edges to at most this length (m)
COVER = 7.5  # road surface below the ground over a tunnel, away from the portals (m)
PORTAL_DEPTH = 6.0  # road surface below the ground at a portal face (5 m headroom + roof)
SHORT_TUNNEL = 150.0  # m: shorter tunnel systems are underpasses that start at grade
RIVER_TUNNEL_Z = -45.0  # m AHD: Clem7 under the Brisbane River (its real low point is about -60 m)
RIVER_TUNNEL_SHORE = 30.0  # m from land: where a tunnel is under the river rather than a creek
SMALL_WATER_TUNNEL = 8.0  # m under the level of creeks and ponds
CLR_ROAD = 5.5  # deck surface above a road surface below (4.6-5 m clearance + deck)
CLR_RAIL = 7.0  # above rail (overhead wires)
CLR_PED = 4.5  # above pedestrian streets, and service over service (car-park ramps over lanes)
# A service way or path signed with a lower maxheight (a car park's lane under its own ramp, Albert
# Street's car park at 1.93 m) needs only that much headroom, plus the structure over it
MAXHEIGHT_DECK = 0.8
# Over a tunnel the renderer builds a tube (src/world/roads.ts TUBE_H 5.8 m, +0.6
# for motorways) with a roof: anything above must clear tube + roof (audit #1,
# #5), plus a margin for the output simplification (ZTOL on both ways).
TUBE_H = 5.8
CLR_TUBE = TUBE_H + 0.6 + 0.2
CLR_TUBE_MWY = CLR_TUBE + 0.6
FOOT_GAP = 0.9  # m: a way whose carriageway comes this close to a tunnel's (in plan) is over its tube
FOOT_CONNECTED = 30.0  # m: ... unless the network joins them closer than this (a junction, a portal)
FOOT_SHORT_PORTAL = 15.0  # m: and not near the portals of short underpasses (they start at grade)
FOOT_PORTAL = 30.0  # m: near-parallel ways this close to a tube's portal run beside it, not over it
STATION_CAP = 0.025  # bus roads alongside a bus platform: 1:40, an accessible platform's limit (sat review #7)
# m from the platform: out to the far carriageway beyond a stopping bay and the near carriageway (at
# 10 m, Roma St's outbound carriageway, 10.5 m from platform 1, kept a 6 % pitch along it while the
# inbound one beside it was held level, and stood 1.1 m over it)
STATION_REACH = 12.0
COUPLE = 6.0  # weight (x node length) tying adjacent parallel carriageways at grade together (M1 #7)
SMALL_WATER_DECK = 3.5  # deck above creeks, ponds and bank-side river viaducts
RIVER_SPAN = 80.0  # a tidal water crossing this long (m) ...
RIVER_SHORE = 35.0  # ... reaching this far (and a quarter of its span) from land is a river bridge
DEFAULT_RIVER_DECK = 14.0  # m AHD crest for unlisted river bridges
WATER_ROAD = 1.0  # at-grade roads whose vertices fall in a water polygon stay this far above it

# Crest deck heights (m AHD; the river is at +0.5 m) of the Brisbane River
# bridges in and near the map, keyed by a point near mid-river (world metres),
# with the profile "dip" (how far the deck falls towards the banks, as a
# fraction of its rise above the water). The Story Bridge deck is about 30 m
# above the river, Captain Cook about 20 m, Victoria, William Jolly, Go Between
# and the green bridges 10-15 m.
RIVER_BRIDGES = [
    ("Story Bridge", 1210.0, 583.0, 30.5, 0.12),
    ("Captain Cook Bridge", 570.0, -1325.0, 20.5, 0.3),
    ("Victoria Bridge", -255.0, -390.0, 12.5, 0.3),
    ("William Jolly Bridge", -800.0, 100.0, 13.5, 0.3),
    ("Go Between Bridge", -1120.0, -90.0, 14.0, 0.3),
    ("Merivale Bridge", -1030.0, -50.0, 13.5, 0.25),
    ("Neville Bonner Bridge", -62.0, -632.0, 13.5, 0.3),
    ("Eleanor Schonell Bridge", -110.0, -3225.0, 14.0, 0.3),
    ("Walter Taylor Bridge", -4930.0, -4120.0, 13.0, 0.25),
]
RIVER_BRIDGE_RADIUS = 260.0

BRIDGE_BUMP = 35.0  # m: how much radar surface a bridge footprint may remove from the DEM
STRUCT_ANCHOR = 0.02  # anchor weight of bridge / tunnel interiors relative to at-grade roads
ZTOL = 0.2  # m: height tolerance when simplifying output polylines (roads, rail)
ROUTE_ZTOL = 0.1  # m: the same for bus routes (AI buses and the guide ride the route z: 61 review #13)
ONEWAY_AGAINST = 4.0  # route matching: per-sample cost of a one-way road driven backwards (twin tubes: the right tube within ~14 m wins; below FREE, so a lone tube the shape runs along still beats off-road)
KIND_GROUPS = (
    ("motorway", (0,)),
    ("trunk", (1,)),
    ("primary/secondary", (2, 3)),
    ("tertiary", (4,)),
    ("residential", (5,)),
    ("service", (6,)),
    ("busway", (7,)),
    ("pedestrian", (8,)),
    ("rail", (RAIL,)),
)


def cap_of(kind: int, link: bool) -> float:
    c = CAP[kind]
    return max(c, LINK_CAP) if link else c


@dataclass
class Line:
    """One OSM way (road or rail) as collected by build_osm."""

    id: int
    nodes: list[int]
    xy: list[tuple[float, float]]
    kind: int
    bridge: bool
    tunnel: bool
    layer: int  # explicit layer tag, 0 if none
    has_layer: bool
    link: bool
    emit: bool
    meta: dict = field(default_factory=dict)  # the output record (roads.json road / rail entry)
    name: str = ""  # for reports only
    reversed: bool = False  # oneway=-1: xy/nodes run against the OSM way
    maxheight: float = 0.0  # signed headroom (m), 0 if none
    # filled by solve(): dense polyline and heights
    dxy: np.ndarray | None = None
    dz: np.ndarray | None = None
    dnodes: np.ndarray | None = None

    @property
    def level(self) -> int:
        if self.has_layer:
            return self.layer
        return 1 if self.bridge else (-1 if self.tunnel else 0)


def log(*a):
    print("elevation:", *a, file=sys.stderr)


# ---------------------------------------------------------------------------
# Graph


def _split_nodes(lines: list[Line]) -> set[int]:
    """OSM nodes that a tunnel or bridge shares with a way of another kind
    passing straight through (the node is interior to both). Those are
    mapping slips at a crossing, not junctions: nothing can turn there, so
    each kind gets its own copy of the node and the crossing is grade
    separated like any other."""
    occ: dict[int, set] = {}
    for ln in lines:
        cls = "B" if ln.bridge else ("T" if ln.tunnel else "S")
        nodes = ln.nodes
        for nid in nodes[1:-1]:
            s = occ.get(nid)
            if s is None:
                occ[nid] = {cls}
            else:
                s.add(cls)
    return {nid for nid, s in occ.items() if len(s) >= 2}


class Graph:
    def __init__(self, lines: list[Line]):
        t = time.time()
        split = _split_nodes(lines)
        idx: dict = {}
        px: list[float] = []
        py: list[float] = []
        ei: list[int] = []
        ej: list[int] = []
        eline: list[int] = []
        osm: list[int] = []  # graph index -> osm id (or -1 for densified points)
        for li, ln in enumerate(lines):
            dn = []
            prev = None
            cls = "B" if ln.bridge else ("T" if ln.tunnel else "S")
            for nid, (x, y) in zip(ln.nodes, ln.xy):
                key = (nid, cls) if nid in split else nid
                g = idx.get(key)
                if g is None:
                    g = len(px)
                    idx[key] = g
                    px.append(x)
                    py.append(y)
                    osm.append(nid)
                if prev is not None:
                    if g == prev:
                        continue
                    x0, y0 = px[prev], py[prev]
                    x1, y1 = px[g], py[g]
                    d = math.hypot(x1 - x0, y1 - y0)
                    n = max(1, int(math.ceil(d / MAX_SEG)))
                    last = prev
                    for s in range(1, n):
                        f = s / n
                        v = len(px)
                        px.append(x0 + (x1 - x0) * f)
                        py.append(y0 + (y1 - y0) * f)
                        osm.append(-1)
                        ei.append(last)
                        ej.append(v)
                        eline.append(li)
                        dn.append(v)
                        last = v
                    ei.append(last)
                    ej.append(g)
                    eline.append(li)
                dn.append(g)
                prev = g
            ln.dnodes = np.asarray(dn, dtype=np.int64)
        self.osm = np.asarray(osm, dtype=np.int64)
        self.x = np.asarray(px)
        self.y = np.asarray(py)
        self.n = n = len(px)
        self.ei = np.asarray(ei, dtype=np.int64)
        self.ej = np.asarray(ej, dtype=np.int64)
        self.eline = np.asarray(eline, dtype=np.int64)
        self.elen = np.maximum(np.hypot(self.x[self.ej] - self.x[self.ei], self.y[self.ej] - self.y[self.ei]), 0.05)
        kinds = np.asarray([ln.kind for ln in lines])
        caps = np.asarray([cap_of(ln.kind, ln.link) for ln in lines])
        ells = np.asarray([ELL[ln.kind] for ln in lines])
        self.ekind = kinds[self.eline]
        self.ecap = caps[self.eline]
        self.eell = ells[self.eline]
        self.elink = np.asarray([ln.link for ln in lines])[self.eline]
        self.ebridge = np.asarray([ln.bridge for ln in lines])[self.eline]
        self.etunnel = np.asarray([ln.tunnel and not ln.bridge for ln in lines])[self.eline]

        def touched(mask):
            out = np.zeros(n, bool)
            out[self.ei[mask]] = True
            out[self.ej[mask]] = True
            return out

        surf = touched(~(self.ebridge | self.etunnel))
        br = touched(self.ebridge)
        tu = touched(self.etunnel)
        self.surface = surf  # touches at least one ordinary edge
        self.bridge = br & ~surf  # bridge interior
        self.tunnel = tu & ~surf & ~br  # tunnel interior
        self.portal = tu & surf
        self.abutment = br & surf
        isr = self.ekind == RAIL
        self.rail_only = touched(isr) & ~touched(~isr)
        # depth below the ground required at a tunnel's portal (0 for car-park ramps)
        self.portal_depth = np.zeros(n)
        tmaj = self.etunnel & ~np.isin(self.ekind, MINOR)
        self.portal_depth[touched(tmaj)] = PORTAL_DEPTH
        # node "length" share for integrating the anchor term
        self.nlen = np.bincount(self.ei, self.elen, n) * 0.5 + np.bincount(self.ej, self.elen, n) * 0.5
        # node class: tightest cap and longest smoothing length of incident edges
        self.ncap = np.full(n, 1.0)
        np.minimum.at(self.ncap, self.ei, self.ecap)
        np.minimum.at(self.ncap, self.ej, self.ecap)
        self.nell = np.zeros(n)
        np.maximum.at(self.nell, self.ei, self.eell)
        np.maximum.at(self.nell, self.ej, self.eell)
        # adjacency in "grade metres" (cap * length), in metres, and of tunnel edges only
        self.adj = self._adj(self.ecap * self.elen)
        self.metric_adj = self._adj(self.elen)
        self.tunnel_adj = self._adj(self.elen, self.etunnel)
        self.n_split = len(split)
        log(f"graph {n} nodes ({int((self.osm >= 0).sum())} OSM), {len(self.ei)} edges, {len(split)} tunnel/bridge nodes "
            f"shared with a crossing way split apart, built in {time.time() - t:.1f}s")

    def level_stations(self, lines: list[Line], zones) -> None:
        """Bus roads alongside a platform climb at most STATION_CAP (the radar
        surface humps under station roofs: Roma St 5.9 %, sat review #7)."""
        bus = np.asarray([ln.kind == 7 or bool(ln.meta.get("bus")) for ln in lines])[self.eline]
        e = np.flatnonzero(bus)
        mid = shapely.points(0.5 * (self.x[self.ei[e]] + self.x[self.ej[e]]), 0.5 * (self.y[self.ei[e]] + self.y[self.ej[e]]))
        qi, _ = shapely.STRtree(list(zones)).query(mid, predicate="dwithin", distance=STATION_REACH)
        e = np.unique(e[qi])
        self.ecap[e] = np.minimum(self.ecap[e], STATION_CAP)
        self.ncap = np.full(self.n, 1.0)
        np.minimum.at(self.ncap, self.ei, self.ecap)
        np.minimum.at(self.ncap, self.ej, self.ecap)
        self.adj = self._adj(self.ecap * self.elen)
        log(f"{len(e)} bus road edges alongside platforms held to {100 * STATION_CAP:.1f} %")

    def _adj(self, w: np.ndarray, mask: np.ndarray | None = None):
        """Symmetric adjacency; overlapping ways that repeat an edge keep the smallest weight."""
        i, j = self.ei, self.ej
        if mask is not None:
            i, j, w = i[mask], j[mask], w[mask]
        lo = np.minimum(i, j)
        hi = np.maximum(i, j)
        key = lo * self.n + hi
        order = np.lexsort((w, key))
        key, w = key[order], w[order]
        first = np.ones(len(key), bool)
        first[1:] = key[1:] != key[:-1]
        key, w = key[first], w[first]
        lo, hi = key // self.n, key % self.n
        return sparse.csr_matrix((np.concatenate([w, w]), (np.concatenate([lo, hi]), np.concatenate([hi, lo]))), shape=(self.n, self.n))

    # Envelopes ------------------------------------------------------------
    def _multisource(self, values: np.ndarray, sources: np.ndarray, adj) -> np.ndarray:
        """min over sources j of (values[j] + dist(i, j)) for every node i (inf if unreachable)."""
        out = np.full(self.n, np.inf)
        if not sources.any():
            return out
        src = np.flatnonzero(sources)
        base = values[src].min()
        n = self.n
        # super source n -> j with weight values[j] - base (+eps: zero weights are dropped)
        w = values[src] - base + 1e-6
        a = adj.tocoo()
        m = sparse.csr_matrix(
            (np.concatenate([a.data, w]), (np.concatenate([a.row, np.full(len(src), n)]), np.concatenate([a.col, src]))),
            shape=(n + 1, n + 1),
        )
        d = csgraph.dijkstra(m, directed=True, indices=n)
        return d[:n] + base - 1e-6

    def lower_envelope(self, z: np.ndarray, ok: np.ndarray | None = None) -> np.ndarray:
        """lo_i = min_j (z_j + d_g(i, j)): the largest cap-respecting function <= z."""
        return self._multisource(z, np.isfinite(z) if ok is None else ok, self.adj)

    def upper_envelope(self, z: np.ndarray, ok: np.ndarray | None = None) -> np.ndarray:
        """hi_i = max_j (z_j - d_g(i, j)): the smallest cap-respecting function >= z."""
        return -self._multisource(-z, np.isfinite(z) if ok is None else ok, self.adj)

    def project_caps(self, z: np.ndarray) -> np.ndarray:
        """Exact grade caps: midpoint of the Lipschitz envelopes (identity where caps already hold)."""
        return 0.5 * (self.lower_envelope(z) + self.upper_envelope(z))


# ---------------------------------------------------------------------------
# Crossings


def find_crossings(g: Graph, lines: list[Line]):
    """Edge pairs that cross in plan without sharing a node and sit on different levels.

    Returns arrays (ea, eb, ta, tb, px, py) where ea is the UPPER edge."""
    t = time.time()
    lvl = np.asarray([ln.level for ln in lines])
    special = np.flatnonzero((lvl[g.eline] != 0) | g.ebridge | g.etunnel | (g.ekind == RAIL))
    segs = shapely.linestrings(np.stack([np.stack([g.x[g.ei], g.y[g.ei]], -1), np.stack([g.x[g.ej], g.y[g.ej]], -1)], 1))
    tree = shapely.STRtree(segs)
    qi, qj = tree.query(segs[special], predicate="intersects")
    a = special[qi]
    b = qj
    keep = a != b
    a, b = a[keep], b[keep]
    shared = (g.ei[a] == g.ei[b]) | (g.ei[a] == g.ej[b]) | (g.ej[a] == g.ei[b]) | (g.ej[a] == g.ej[b])
    a, b = a[~shared], b[~shared]
    lo = np.minimum(a, b)
    hi = np.maximum(a, b)
    key = np.unique(lo * (len(g.ei) + 1) + hi)
    a = key // (len(g.ei) + 1)
    b = key % (len(g.ei) + 1)
    # intersection parameters
    p0 = np.stack([g.x[g.ei[a]], g.y[g.ei[a]]], -1)
    p1 = np.stack([g.x[g.ej[a]], g.y[g.ej[a]]], -1)
    q0 = np.stack([g.x[g.ei[b]], g.y[g.ei[b]]], -1)
    q1 = np.stack([g.x[g.ej[b]], g.y[g.ej[b]]], -1)
    r = p1 - p0
    s = q1 - q0
    den = r[:, 0] * s[:, 1] - r[:, 1] * s[:, 0]
    ok = np.abs(den) > 1e-9
    qp = q0 - p0
    ta = np.clip(np.where(ok, (qp[:, 0] * s[:, 1] - qp[:, 1] * s[:, 0]) / np.where(ok, den, 1), 0.5), 0, 1)
    tb = np.clip(np.where(ok, (qp[:, 0] * r[:, 1] - qp[:, 1] * r[:, 0]) / np.where(ok, den, 1), 0.5), 0, 1)
    la, lb = g.eline[a], g.eline[b]
    same_line = la == lb
    # who is on top: the layer, nudged up for bridges and down for tunnels
    va = lvl[la] + 0.5 * g.ebridge[a] - 0.5 * g.etunnel[a]
    vb = lvl[lb] + 0.5 * g.ebridge[b] - 0.5 * g.etunnel[b]
    swap = vb > va
    a, b = np.where(swap, b, a), np.where(swap, a, b)
    ta, tb = np.where(swap, tb, ta), np.where(swap, ta, tb)
    keep = (va != vb) & ~same_line
    a, b, ta, tb = a[keep], b[keep], ta[keep], tb[keep]
    px = g.x[g.ei[a]] + (g.x[g.ej[a]] - g.x[g.ei[a]]) * ta
    py = g.y[g.ei[a]] + (g.y[g.ej[a]] - g.y[g.ei[a]]) * ta
    log(f"{len(a)} grade-separated crossings in {time.time() - t:.1f}s")
    return a, b, ta, tb, px, py


def _half_widths(lines: list[Line]) -> np.ndarray:
    return np.asarray([2.1 if ln.kind == RAIL else 0.5 * float(ln.meta.get("w", 6.0)) for ln in lines])


def find_footprints(g: Graph, lines: list[Line], skip: np.ndarray, near_portal: np.ndarray | None = None):
    """Ways over a tunnel's tube without crossing its centreline (a street along
    a tunnel, a service loop over a busway tube: audit #1, #5): every pair of a
    tunnel edge and a non-tunnel edge whose carriageways come within FOOT_GAP in
    plan, at their closest points. skip: tunnel nodes to leave out (near the
    portals of underpasses). Returns (ea, eb, ta, tb, px, py, minor) with ea the
    upper (non-tunnel) edge, as find_crossings. Left out: pairs the network
    joins within FOOT_CONNECTED (a junction, a portal approach), and ways side
    by side rather than over: near-parallel, and carriageways apart or within
    FOOT_PORTAL of the tube's portal (near_portal: tunnel nodes): the open
    approach of one twin tube beside the other's tube wall at a staggered
    portal, whose OSM centrelines are often closer than our carriageway widths
    (the Cultural Centre Tunnel and Clem7 were dug 11 m deep by such pairs).
    minor: the upper way is an unnamed service way or path, which
    gives way (it leaves the output if it intrudes, audit #1) rather than
    pushing a busway or motorway down."""
    t = time.time()
    ehw = _half_widths(lines)[g.eline]
    tun = np.flatnonzero(g.etunnel & (g.ekind != RAIL) & ~(skip[g.ei] & skip[g.ej]))
    oth = np.flatnonzero(~g.etunnel)
    segs = shapely.linestrings(np.stack([np.stack([g.x[g.ei], g.y[g.ei]], -1), np.stack([g.x[g.ej], g.y[g.ej]], -1)], 1))
    tree = shapely.STRtree(segs[oth])
    qi, qj = tree.query(segs[tun], predicate="dwithin", distance=ehw[tun] + float(ehw.max()) + FOOT_GAP)
    eb, ea = tun[qi], oth[qj]
    d = shapely.distance(segs[eb], segs[ea])
    keep = (d > 1e-6) & (d < ehw[eb] + ehw[ea] + FOOT_GAP)
    shared = (g.ei[ea] == g.ei[eb]) | (g.ei[ea] == g.ej[eb]) | (g.ej[ea] == g.ei[eb]) | (g.ej[ea] == g.ej[eb])
    keep &= ~shared
    ea, eb = ea[keep], eb[keep]
    c = shapely.get_coordinates(shapely.shortest_line(segs[eb], segs[ea])).reshape(-1, 2, 2)

    def param(e, p):
        dx, dy = g.x[g.ej[e]] - g.x[g.ei[e]], g.y[g.ej[e]] - g.y[g.ei[e]]
        l2 = np.maximum(dx * dx + dy * dy, 1e-12)
        return np.clip(((p[:, 0] - g.x[g.ei[e]]) * dx + (p[:, 1] - g.y[g.ei[e]]) * dy) / l2, 0.0, 1.0)

    tb = param(eb, c[:, 0])
    ta = param(ea, c[:, 1])
    ua = np.stack([g.x[g.ej[ea]] - g.x[g.ei[ea]], g.y[g.ej[ea]] - g.y[g.ei[ea]]], 1)
    ub = np.stack([g.x[g.ej[eb]] - g.x[g.ei[eb]], g.y[g.ej[eb]] - g.y[g.ei[eb]]], 1)
    cos = np.abs((ua * ub).sum(1)) / np.maximum(np.hypot(*ua.T) * np.hypot(*ub.T), 1e-9)
    portal = np.zeros(len(ea), bool) if near_portal is None else (near_portal[g.ei[eb]] | near_portal[g.ej[eb]])
    beside = (cos > 0.85) & ((d[keep] >= ehw[ea] + ehw[eb] - 0.5) | portal)
    near = _net_distance(g, g.metric_adj, g.ei[ea], g.ej[ea], g.ei[eb], g.ej[eb], ta, tb, FOOT_CONNECTED) < FOOT_CONNECTED
    ok = ~near & ~beside
    ea, eb, ta, tb, c = ea[ok], eb[ok], ta[ok], tb[ok], c[ok]
    minor_line = np.asarray([ln.kind in MINOR and not ln.meta.get("n") and not ln.meta.get("bus") and not ln.bridge for ln in lines])
    minor = minor_line[g.eline[ea]]
    log(f"{len(ea)} footprint pairs (ways over a tunnel's tube off its centreline; {int(minor.sum())} of minor ways), "
        f"{int(near.sum())} joined nearby and {int((beside & ~near).sum())} side by side left out, in {time.time() - t:.1f}s")
    return ea, eb, ta, tb, c[:, 1, 0], c[:, 1, 1], minor


def coupling_rows(g: Graph, lines: list[Line]):
    """Adjacent parallel carriageways at grade (a bus lane beside the general
    lanes, the two sides of a dual carriageway): rows (i, j0, j1, t, w) tying
    node i to the point at t on edge (j0, j1) of the other way (M1 #7)."""
    t0 = time.time()
    hw = _half_widths(lines)
    lvl = np.asarray([ln.level for ln in lines])
    ok_line = np.asarray([ln.kind <= 7 and not ln.bridge and not ln.tunnel for ln in lines])
    e_ok = ok_line[g.eline]
    nodes = np.flatnonzero(g.surface & ~g.portal & ~g.abutment)
    # a representative edge (direction, line) per node
    first = np.full(g.n, -1)
    ok_e = np.flatnonzero(e_ok)
    first[g.ei[ok_e]] = ok_e
    first[g.ej[ok_e]] = ok_e
    nodes = nodes[first[nodes] >= 0]
    en = first[nodes]
    ln_i = g.eline[en]
    segs = shapely.linestrings(np.stack([np.stack([g.x[g.ei[ok_e]], g.y[g.ei[ok_e]]], -1), np.stack([g.x[g.ej[ok_e]], g.y[g.ej[ok_e]]], -1)], 1))
    tree = shapely.STRtree(segs)
    pts = shapely.points(g.x[nodes], g.y[nodes])
    reach = hw[ln_i] + float(hw.max()) + 1.0
    qi, qj = tree.query(pts, predicate="dwithin", distance=reach)
    e = ok_e[qj]
    i = nodes[qi]
    li, lj = ln_i[qi], g.eline[e]
    d = shapely.distance(pts[qi], segs[qj])
    good = (li != lj) & (lvl[li] == lvl[lj]) & (d < hw[li] + hw[lj] + 1.0) & (d > 0.5)
    good &= (g.ei[e] != i) & (g.ej[e] != i)
    ui = np.stack([g.x[g.ej[en[qi]]] - g.x[g.ei[en[qi]]], g.y[g.ej[en[qi]]] - g.y[g.ei[en[qi]]]], 1)
    uj = np.stack([g.x[g.ej[e]] - g.x[g.ei[e]], g.y[g.ej[e]] - g.y[g.ei[e]]], 1)
    cos = np.abs((ui * uj).sum(1)) / np.maximum(np.hypot(*ui.T) * np.hypot(*uj.T), 1e-9)
    good &= cos > 0.94
    dx, dy = uj[:, 0], uj[:, 1]
    tt = np.clip(((g.x[i] - g.x[g.ei[e]]) * dx + (g.y[i] - g.y[g.ei[e]]) * dy) / np.maximum(dx * dx + dy * dy, 1e-12), 0, 1)
    good &= (tt > 0.0) & (tt < 1.0) | (np.hypot(*uj.T) < 12.0)
    i, e, tt, d = i[good], e[good], tt[good], d[good]
    # the nearest such edge per node
    order = np.lexsort((d, i))
    i, e, tt = i[order], e[order], tt[order]
    firsts = np.ones(len(i), bool)
    firsts[1:] = i[1:] != i[:-1]
    i, e, tt = i[firsts], e[firsts], tt[firsts]
    w = COUPLE * g.nlen[i]
    log(f"{len(i)} nodes tied to an adjacent parallel carriageway in {time.time() - t0:.1f}s")
    return i, g.ei[e], g.ej[e], tt, w


# ---------------------------------------------------------------------------
# Solve


def _bending_rows(g: Graph, lines: list[Line]):
    """Triplets (i, j, k) along ways and straight-through across way joints."""
    I: list[np.ndarray] = []
    J: list[np.ndarray] = []
    K: list[np.ndarray] = []
    for ln in lines:
        d = ln.dnodes
        if len(d) >= 3:
            I.append(d[:-2])
            J.append(d[1:-1])
            K.append(d[2:])
    # joints: a way's end continues straight on into another way
    ends: dict[int, list[int]] = {}
    for ln in lines:
        d = ln.dnodes
        if len(d) < 2:
            continue
        for node, nb in ((d[0], d[1]), (d[-1], d[-2])):
            ends.setdefault(int(node), []).append(int(nb))
    nbrs: dict[int, set] = {}
    for ln in lines:
        d = ln.dnodes
        for k in range(len(d)):
            v = int(d[k])
            if v in ends:
                s = nbrs.setdefault(v, set())
                if k > 0:
                    s.add(int(d[k - 1]))
                if k + 1 < len(d):
                    s.add(int(d[k + 1]))
    xi, xj, xk = [], [], []
    for v, end_nbs in ends.items():
        allnb = nbrs.get(v, set())
        for a in end_nbs:
            best = None
            bestc = -0.7  # cos of the angle between the two legs; -1 = straight on
            ax, ay = g.x[a] - g.x[v], g.y[a] - g.y[v]
            la = math.hypot(ax, ay) or 1.0
            for b in allnb:
                if b == a:
                    continue
                bx, by = g.x[b] - g.x[v], g.y[b] - g.y[v]
                c = (ax * bx + ay * by) / (la * (math.hypot(bx, by) or 1.0))
                if c < bestc:
                    bestc = c
                    best = b
            if best is not None:
                xi.append(a)
                xj.append(v)
                xk.append(best)
    if xi:
        I.append(np.asarray(xi, dtype=np.int64))
        J.append(np.asarray(xj, dtype=np.int64))
        K.append(np.asarray(xk, dtype=np.int64))
    i = np.concatenate(I)
    j = np.concatenate(J)
    k = np.concatenate(K)
    ok = (i != j) & (j != k) & (i != k)
    i, j, k = i[ok], j[ok], k[ok]
    lo = np.minimum(i, k)
    hi = np.maximum(i, k)
    key = np.unique(np.stack([lo, j, hi], 1), axis=0)
    return key[:, 0], key[:, 1], key[:, 2]


def _net_distance(g: Graph, adj, a0, a1, b0, b1, ta, tb, limit: float) -> np.ndarray:
    """Network distance (in the metric of adj) between the points at ta on edges
    (a0, a1) and at tb on edges (b0, b1) (inf when further than limit)."""
    out = np.full(len(a0), np.inf)
    if not len(a0):
        return out
    wa = np.asarray(adj[a0, a1]).ravel()  # length of the first edge in this metric
    wb = np.asarray(adj[b0, b1]).ravel()
    src = np.unique(np.concatenate([a0, a1]))
    pos = np.full(g.n, -1)
    pos[src] = np.arange(len(src))
    for c0 in range(0, len(src), 64):
        chunk = src[c0 : c0 + 64]
        d = csgraph.dijkstra(adj, directed=False, indices=chunk, limit=limit)
        for va, fa in ((a0, ta), (a1, 1.0 - ta)):
            r = pos[va] - c0
            k = np.flatnonzero((r >= 0) & (r < len(chunk)))
            if not len(k):
                continue
            rr = r[k]
            best = np.minimum(d[rr, b0[k]] + tb[k] * wb[k], d[rr, b1[k]] + (1.0 - tb[k]) * wb[k]) + fa[k] * wa[k]
            out[k] = np.minimum(out[k], best)
    return out


def _grade_distance(g: Graph, a0, a1, b0, b1, ta, tb, limit: float) -> np.ndarray:
    """Grade-metric network distance between the crossing points on edges (a0, a1) and (b0, b1)
    (inf when further than limit)."""
    return _net_distance(g, g.adj, a0, a1, b0, b1, ta, tb, limit)


def _system(g: Graph, lines: list[Line], alpha: np.ndarray, target: np.ndarray):
    """H = D^T W D + diag(alpha) and b for the anchor + bending energy."""
    n = g.n
    i, j, k = _bending_rows(g, lines)
    l1 = np.maximum(np.hypot(g.x[j] - g.x[i], g.y[j] - g.y[i]), 0.5)
    l2 = np.maximum(np.hypot(g.x[k] - g.x[j], g.y[k] - g.y[j]), 0.5)
    c = 2.0 / (l1 + l2)
    ci = c / l1
    ck = c / l2
    cj = -(ci + ck)
    ell = np.maximum(g.nell[j], 1.0)
    wb = ell**4 * (l1 + l2) * 0.5
    rows = np.repeat(np.arange(len(i)), 3)
    cols = np.stack([i, j, k], 1).ravel()
    vals = np.stack([ci, cj, ck], 1).ravel()
    D = sparse.csr_matrix((vals, (rows, cols)), shape=(len(i), n))
    H = (D.T @ sparse.diags(wb) @ D).tocsr() + sparse.diags(alpha)
    # adjacent parallel carriageways: w (z_i - z_on_the_other)^2
    ci_, j0, j1, t, w = coupling_rows(g, lines)
    m = len(ci_)
    rows = np.repeat(np.arange(m), 3)
    cols = np.stack([ci_, j0, j1], 1).ravel()
    vals = np.stack([np.ones(m), -(1.0 - t), -t], 1).ravel()
    C = sparse.csr_matrix((vals, (rows, cols)), shape=(m, n))
    H = H + (C.T @ sparse.diags(w) @ C).tocsr()
    return H.tocsr(), alpha * target


def _box_qp(H, b, L, U, z0, iters=60):
    """min 1/2 z'Hz - b'z  s.t. L <= z <= U: primal active set with sparse direct solves."""
    z = np.clip(z0, L, U)
    eq = U - L < 1e-6  # pinned nodes never leave the active set
    fix_lo = (z0 <= L + 1e-9) | eq
    fix_hi = (z0 >= U - 1e-9) & ~fix_lo
    released = np.zeros(len(b), np.int32)  # anti-cycling: a node released 3 times stays put
    it = 0
    for it in range(iters):
        fixed = fix_lo | fix_hi
        free = ~fixed
        v = np.where(fix_lo, L, np.where(fix_hi, U, 0.0))
        v = np.where(np.isfinite(v), v, 0.0)
        Hf = H[free]
        Hff = Hf[:, free]
        rhs = b[free] - Hf[:, fixed] @ v[fixed]
        zf = splu(Hff.tocsc(), permc_spec="MMD_AT_PLUS_A", diag_pivot_thresh=0.0, options={"SymmetricMode": True}).solve(rhs)
        z = v.copy()
        z[free] = zf
        lo_v = free & (z < L - 1e-4)
        hi_v = free & (z > U + 1e-4)
        grad = H @ z - b
        stuck = eq | (released >= 3)
        rel_lo = fix_lo & (grad < -1e-6) & ~stuck
        rel_hi = fix_hi & (grad > 1e-6) & ~stuck
        changed = int(lo_v.sum() + hi_v.sum() + rel_lo.sum() + rel_hi.sum())
        if changed == 0:
            break
        released += rel_lo | rel_hi
        fix_lo = (fix_lo & ~rel_lo) | lo_v
        fix_hi = (fix_hi & ~rel_hi) | hi_v
    return np.clip(z, L, U), it + 1


class WaterInfo:
    """Water level (NaN on land) and distance to the nearest land from the cleaned terrain."""

    def __init__(self, grid, level_grid: np.ndarray):
        self.g = grid
        self.lv = level_grid
        self.dist = ndimage.distance_transform_edt(np.isfinite(level_grid)) * grid.cell

    def _idx(self, x, y):
        g = self.g
        i = np.rint((np.asarray(x) - g.x0) / g.cell).astype(np.int64)
        j = np.rint((np.asarray(y) - g.y0) / g.cell).astype(np.int64)
        ok = (i >= 0) & (i < g.nx) & (j >= 0) & (j < g.ny)
        return np.clip(i, 0, g.nx - 1), np.clip(j, 0, g.ny - 1), ok

    def level(self, x, y) -> np.ndarray:
        i, j, ok = self._idx(x, y)
        return np.where(ok, self.lv[j, i], np.nan)

    def shore_dist(self, x, y) -> np.ndarray:
        i, j, ok = self._idx(x, y)
        return np.where(ok, self.dist[j, i], 0.0)


def solve(lines: list[Line], ground, water: WaterInfo, tidal_level: float = 0.5, box=None, stations=None) -> dict:
    """Give every line a dense polyline (dxy) with heights (dz, m AHD).

    ground:   callable (x, y) -> terrain height (m AHD), vectorised
    water:    WaterInfo of the same terrain
    stations: shapely geometries of the bus platforms (their busways stay level)
    Returns a stats dict for the report.
    """
    t0 = time.time()
    g = Graph(lines)
    n = g.n
    if stations:
        g.level_stations(lines, stations)
    T = np.asarray(ground(g.x, g.y), dtype=np.float64)
    wl = water.level(g.x, g.y)
    inwater = np.isfinite(wl)
    # roads and decks never dip into water polygons (river beds sit below the level)
    Tg = np.where(inwater & ~g.tunnel, np.maximum(T, np.where(inwater, wl, 0.0) + WATER_ROAD), T)

    # ---- direct bounds that do not depend on other ways ------------------
    Lb = np.full(n, -np.inf)
    Ub = np.full(n, np.inf)
    foot_skip = np.zeros(n, bool)
    foot_portal = np.zeros(n, bool)
    # tunnels: PORTAL_DEPTH below the ground at a portal, deepening to COVER at the cap
    tun = g.tunnel | g.portal
    if tun.any():
        portals = np.flatnonzero(g.portal)
        if len(portals):
            d_portal = csgraph.dijkstra(g.tunnel_adj, directed=False, indices=portals, min_only=True)
        else:
            d_portal = np.full(n, np.inf)
        # tunnel systems shorter than SHORT_TUNNEL are underpasses: they start at
        # grade and take their depth from whatever crosses above them
        ncomp, tlab = csgraph.connected_components(g.tunnel_adj, directed=False)
        te = g.etunnel
        comp_len = np.bincount(tlab[g.ei[te]], g.elen[te], ncomp)
        pdepth = np.where(comp_len[tlab] < SHORT_TUNNEL, 0.0, g.portal_depth)
        depth = np.minimum(COVER, pdepth + g.ncap * d_portal)
        Ub[tun] = T[tun] - depth[tun]
        foot_skip = (comp_len[tlab] < SHORT_TUNNEL) & (d_portal < FOOT_SHORT_PORTAL)
        foot_portal = g.tunnel & (d_portal < FOOT_PORTAL)
    # the river itself (wide tidal water), not tidal creeks
    river_tunnel = g.tunnel & inwater & (wl <= tidal_level + 0.1) & (water.shore_dist(g.x, g.y) >= RIVER_TUNNEL_SHORE)
    Ub[river_tunnel] = np.minimum(Ub[river_tunnel], RIVER_TUNNEL_Z)
    pond_tunnel = g.tunnel & inwater & ~river_tunnel
    Ub[pond_tunnel] = np.minimum(Ub[pond_tunnel], wl[pond_tunnel] - SMALL_WATER_TUNNEL)
    # bridge decks above the ground they span (tapered from the abutments)
    if g.bridge.any():
        d_end = csgraph.dijkstra(g.metric_adj, directed=False, indices=np.flatnonzero(~g.bridge), min_only=True)
        d_end = np.where(np.isfinite(d_end), d_end, 0.0)
    else:
        d_end = np.zeros(n)
    deck_min = Tg + np.minimum(1.5, 0.08 * d_end)
    Lb[g.bridge] = np.maximum(Lb[g.bridge], deck_min[g.bridge])

    # water crossings by bridges: components of bridge edges over water
    river_report = []
    wedge = g.ebridge & inwater[g.ei] & inwater[g.ej]
    if wedge.any():
        shore = water.shore_dist(g.x, g.y)
        m = sparse.csr_matrix((np.ones(wedge.sum()), (g.ei[wedge], g.ej[wedge])), shape=(n, n))
        _, lab = csgraph.connected_components(m, directed=False)
        members = np.zeros(n, bool)
        members[g.ei[wedge]] = True
        members[g.ej[wedge]] = True
        for c in np.unique(lab[members]):
            nodes = np.flatnonzero(members & (lab == c))
            xs, ys = g.x[nodes], g.y[nodes]
            cx, cy = xs.mean(), ys.mean()
            pts = np.stack([xs - cx, ys - cy], 1)
            if len(nodes) >= 2:
                _, _, vt = np.linalg.svd(pts, full_matrices=False)
                s = pts @ vt[0]
            else:
                s = np.zeros(len(nodes))
            span = float(s.max() - s.min())
            level = float(np.nanmin(wl[nodes]))
            tidal = level <= tidal_level + 0.1
            deep = float(shore[nodes].max())
            # a crossing reaches mid-river; a viaduct along the bank stays near it
            if tidal and span >= RIVER_SPAN and deep >= max(RIVER_SHORE, 0.25 * span):
                crest, dip, name = DEFAULT_RIVER_DECK, 0.3, "river bridge"
                best = RIVER_BRIDGE_RADIUS
                for nm, bx, by, h, dp in RIVER_BRIDGES:
                    dd = math.hypot(bx - cx, by - cy)
                    if dd < best:
                        best, crest, name, dip = dd, h, nm, dp
                tt = (s - s.min()) / max(span, 1e-6)
                prof = level + (crest - level) * (1.0 - dip * (2 * tt - 1) ** 2)
                Lb[nodes] = np.maximum(Lb[nodes], prof)
                ways = sorted({lines[int(li)].name for li in g.eline[wedge & (lab[g.ei] == c)]} - {""})
                river_report.append((name, round(cx), round(cy), round(span), round(deep), crest, ", ".join(ways)))
            else:
                Lb[nodes] = np.maximum(Lb[nodes], level + SMALL_WATER_DECK)

    # ---- crossings ---------------------------------------------------------
    ea, eb, ta, tb, cx_, cy_ = find_crossings(g, lines)
    fa, fb, fta, ftb, fx, fy, fminor = find_footprints(g, lines, foot_skip, foot_portal)
    # minor unnamed ways over a tube are checked after the solve, not obeyed
    soft = (fa[fminor], fb[fminor], fta[fminor], ftb[fminor], fx[fminor], fy[fminor])
    fa, fb, fta, ftb, fx, fy = (v[~fminor] for v in (fa, fb, fta, ftb, fx, fy))
    nxing = len(ea)
    ea, eb, ta, tb = (np.concatenate(v) for v in ((ea, fa), (eb, fb), (ta, fta), (tb, ftb)))
    cx_, cy_ = np.concatenate([cx_, fx]), np.concatenate([cy_, fy])
    foot = np.arange(len(ea)) >= nxing
    lvl = np.asarray([ln.level for ln in lines])
    la, lb = g.eline[ea], g.eline[eb]
    up_bridge = g.ebridge[ea]
    low_tunnel = g.etunnel[eb]
    # the mover: the bridge, else the tunnel, else the way off level 0
    raise_up = up_bridge | (~low_tunnel & ((lvl[la] > 0) | ~(lvl[lb] < 0)))
    lower_low = ~raise_up
    clr = np.where(g.ekind[eb] == RAIL, CLR_RAIL, np.where(g.ekind[eb] == 8, CLR_PED, CLR_ROAD))
    clr = np.where(lower_low & (g.ekind[ea] == RAIL), CLR_RAIL, clr)
    clr = np.where(np.isin(g.ekind[ea], MINOR) & np.isin(g.ekind[eb], MINOR), CLR_PED, clr)
    # over a tunnel: its tube and roof (whatever the kinds)
    tube = low_tunnel & (g.ekind[eb] != RAIL)
    clr = np.where(tube, np.maximum(clr, np.where(g.ekind[eb] == 0, CLR_TUBE_MWY, CLR_TUBE)), clr)
    # a minor way under it signed with a lower maxheight (never a tube: the renderer's is full height)
    mh = np.asarray([ln.maxheight for ln in lines])[lb]
    signed = (mh > 0) & np.isin(g.ekind[eb], MINOR) & ~tube
    clr = np.where(signed, np.minimum(clr, mh + MAXHEIGHT_DECK), clr)
    log(f"{int(signed.sum())} crossings over minor ways signed with a maxheight (clearance from the sign)")
    clr_full = clr.copy()
    # Two ways that also meet at a junction nearby can only be as far apart
    # vertically as the grade caps allow along the network between the two
    # crossing points (mapping artefacts at at-grade landings, tunnels that
    # cross just before they merge): never ask for more than that.
    reach = _grade_distance(g, g.ei[ea], g.ej[ea], g.ei[eb], g.ej[eb], ta, tb, float(clr.max()) + 1.0)
    relaxed = reach < clr
    clr = np.where(relaxed, np.maximum(0.0, 0.9 * reach - 0.2), clr)
    log(f"{int(relaxed.sum())} crossings relaxed to what the grade caps allow between them")

    # ---- solve loop ----------------------------------------------------------
    # At-grade nodes follow the ground; bridge and tunnel interiors are held
    # only weakly (STRUCT_ANCHOR), towards the lowest legal deck / the
    # shallowest legal tunnel once the crossing bounds are known, so they bend
    # smoothly between their ends without overshooting.
    alpha = np.where(g.surface, 1.0, STRUCT_ANCHOR) * g.nlen
    alpha = np.where(g.rail_only & g.surface, 0.4 * g.nlen, alpha)
    alpha = np.maximum(alpha, 1e-6)
    target = Tg.copy()
    target[g.tunnel] = np.minimum(T[g.tunnel] - COVER - 2.0, Ub[g.tunnel])
    target[g.bridge] = np.maximum(Tg[g.bridge], Lb[g.bridge])
    H, b = _system(g, lines, alpha, target)

    stats: dict = {"river_bridges": river_report}

    def spread(L, U):
        """Spread the bounds with the grade caps; conflicting structures (rare) meet in the middle."""
        Lp = g.upper_envelope(L, np.isfinite(L))
        Up = g.lower_envelope(U, np.isfinite(U))
        bad = Lp > Up + 1e-6
        mid = 0.5 * (Lp[bad] + Up[bad])
        Lp[bad] = mid
        Up[bad] = mid
        return Lp, Up, bad

    def at(zz, e, t):
        return zz[g.ei[e]] * (1 - t) + zz[g.ej[e]] * t

    # Crossing bounds against reference heights (terrain-following within the
    # bounds so far): bridges are raised in ascending order of the layer they
    # sit on, then tunnels lowered in descending order, so a stack of decks
    # builds up once and never feeds back on itself through the ramps that
    # connect its levels.
    va = lvl[la] + 0.5 * g.ebridge[ea] - 0.5 * g.etunnel[ea]
    vb = lvl[lb] + 0.5 * g.ebridge[eb] - 0.5 * g.etunnel[eb]
    L, U = Lb.copy(), Ub.copy()
    Lp, Up, bad = spread(L, U)
    ref = np.clip(target, Lp, Up)
    need = np.full(len(ea), np.nan)
    lim = np.full(len(ea), np.nan)
    for lev in np.unique(va[raise_up]):
        sel = raise_up & (va == lev)
        need[sel] = at(ref, eb[sel], tb[sel]) + clr[sel]
        for ends in (g.ei[ea[sel]], g.ej[ea[sel]]):
            np.maximum.at(L, ends, need[sel])
        Lp, Up, bad = spread(L, U)
        ref = np.clip(target, Lp, Up)
    for lev in np.unique(vb[lower_low])[::-1]:
        sel = lower_low & (vb == lev)
        lim[sel] = at(ref, ea[sel], ta[sel]) - clr[sel]
        for ends in (g.ei[eb[sel]], g.ej[eb[sel]]):
            np.minimum.at(U, ends, lim[sel])
        Lp, Up, bad = spread(L, U)
        ref = np.clip(target, Lp, Up)
    target[g.bridge] = np.maximum(Tg[g.bridge], Lp[g.bridge])
    target[g.tunnel] = np.minimum(T[g.tunnel] - COVER, Up[g.tunnel])
    b = alpha * target
    z, its = _box_qp(H, b, Lp, Up, ref)
    log(f"pass 1: {its} active-set iterations, {int(bad.sum())} conflicting nodes ({time.time() - t0:.0f}s)")

    # Repair passes: the smoothed solution moved the ways under (over) the
    # crossings (decks bend between their constraints); re-check the
    # clearances against it, each pass moving a bound by at most REPAIR
    # metres, so a contradictory stack cannot ratchet upwards.
    # Where the mover still cannot make the clearance (a deck that has to come
    # down to a portal or junction nearby), the other way gives way too: the
    # road under a deck dips, the street over a tunnel humps.
    # A deck's bound follows the way under it down as well as up: the first
    # pass asked for the clearance over that way's reference height, which
    # its own constraints may have lowered since (Victoria Bridge humped 3-4 m
    # over the expressway ramps: sat review #8).
    REPAIR = 3.0
    # (three passes: a deck over a way that the second pass lifts gets its own repair after it, as the
    # Airport Link ramps over the M3 ramp at Bowen Hills, whose deck the second pass raised 4 m)
    REPAIR_PASSES = 3
    U2 = U.copy()
    Lkeep = Lb.copy()  # direct bounds and what the ways over lowered tunnels had to give
    for rp in range(REPAIR_PASSES):
        za, zb = at(z, ea, ta), at(z, eb, tb)
        short = za - zb < clr - 0.2
        sel = raise_up
        need = np.where(sel, np.minimum(zb + clr + 0.2, need + REPAIR), need)
        L2 = Lkeep.copy()
        for ends in (g.ei[ea[sel]], g.ej[ea[sel]]):
            np.maximum.at(L2, ends, need[sel])
        give = sel & short
        for ends in (g.ei[eb[give]], g.ej[eb[give]]):
            np.minimum.at(U2, ends, np.maximum(za[give] - clr[give], zb[give] - REPAIR))
        sel = lower_low
        lim = np.minimum(lim, np.where(sel, np.maximum(za - clr, lim - REPAIR), lim))
        for ends in (g.ei[eb[sel]], g.ej[eb[sel]]):
            np.minimum.at(U2, ends, lim[sel])
        give = sel & short
        for ends in (g.ei[ea[give]], g.ej[ea[give]]):
            np.maximum.at(Lkeep, ends, np.minimum(zb[give] + clr[give], za[give] + REPAIR))
            np.maximum.at(L2, ends, np.minimum(zb[give] + clr[give], za[give] + REPAIR))
        Lp, Up, bad = spread(L2, U2)
        target[g.bridge] = np.maximum(Tg[g.bridge], Lp[g.bridge])
        target[g.tunnel] = np.minimum(T[g.tunnel] - COVER, Up[g.tunnel])
        b = alpha * target
        z_new, its = _box_qp(H, b, Lp, Up, z)
        log(f"repair pass {rp + 1}: {its} active-set iterations, {int(bad.sum())} conflicting nodes, max change {float(np.max(np.abs(z_new - z))):.2f} m ({time.time() - t0:.0f}s)")
        z = z_new
    stats["L"], stats["U"] = L2, U2

    # ---- exact grade caps, then a light smoothing and caps again ----------------
    z = g.project_caps(z)
    nb_sum = np.bincount(g.ei, z[g.ej], n) + np.bincount(g.ej, z[g.ei], n)
    deg = np.bincount(g.ei, None, n) + np.bincount(g.ej, None, n)
    zs = np.where(deg > 0, 0.5 * z + 0.5 * nb_sum / np.maximum(deg, 1), z)
    z = g.project_caps(np.clip(zs, Lp, Up))
    z = np.minimum(np.maximum(z, Lp), Up)

    for ln in lines:
        ln.dxy = np.stack([g.x[ln.dnodes], g.y[ln.dnodes]], 1)
        ln.dz = z[ln.dnodes]

    # ---- report ---------------------------------------------------------------
    slope = np.abs(z[g.ej] - z[g.ei]) / g.elen
    long_enough = g.elen > 2.0
    grade = {}
    for kname, kinds in KIND_GROUPS:
        msk = np.isin(g.ekind, kinds) & long_enough & ~g.elink
        if msk.any():
            grade[kname] = (float(slope[msk].max()), float(np.percentile(slope[msk], 99)))
    msk = g.elink & long_enough
    if msk.any():
        grade["*_link ramps"] = (float(slope[msk].max()), float(np.percentile(slope[msk], 99)))
    stats["grade"] = grade
    dev = z - Tg
    sm = g.surface & ~g.portal & ~g.abutment
    stats["surface_dev"] = (float(np.percentile(np.abs(dev[sm]), 50)), float(np.percentile(np.abs(dev[sm]), 99)), float(np.abs(dev[sm]).max()))
    stats["conflicts"] = int(bad.sum())
    stats["bad"], stats["Lp"], stats["Up"], stats["Lb"], stats["Ub"] = bad, Lp, Up, Lb, Ub
    stats["cross"] = (ea, eb, ta, tb, clr, raise_up)
    za = z[g.ei[ea]] * (1 - ta) + z[g.ej[ea]] * ta
    zb = z[g.ei[eb]] * (1 - tb) + z[g.ej[eb]] * tb
    gap = za - zb
    bx0, by0, bx1, by1 = box if box is not None else (-np.inf, -np.inf, np.inf, np.inf)
    inside = (cx_ >= bx0) & (cx_ <= bx1) & (cy_ >= by0) & (cy_ <= by1)
    short = (gap < clr - 0.3) & inside
    stats["crossings"] = (int(inside.sum()), int(short.sum()), float(np.min((gap - clr)[inside])) if inside.any() else 0.0,
                          float(np.percentile((clr - gap)[short], 50)) if short.any() else 0.0)
    # Ways still inside a tunnel's tube (the grade caps could not make the
    # clearance, as at a portal): minor unnamed ones leave the output (the
    # service loop over the Roma St busway tube, audit #1); the rest are reported.
    intr = tube & (gap < clr_full - 0.3) & (gap > -1.0)
    drops: dict[int, tuple] = {}
    for k in np.flatnonzero(intr):
        ln = lines[int(la[k])]
        if ln.emit and ln.kind in MINOR and not ln.bridge and not ln.meta.get("n") and not ln.meta.get("bus"):
            drops.setdefault(int(la[k]), (ln.id, ln.kind, round(float(gap[k]), 1), round(float(cx_[k])), round(float(cy_[k]))))
    sa, sb, sta, stb, sx, sy = soft
    sgap = at(z, sa, sta) - at(z, sb, stb)
    sclr = np.where(g.ekind[sb] == 0, CLR_TUBE_MWY, CLR_TUBE)
    for k in np.flatnonzero((sgap < sclr - 0.3) & (sgap > -1.0)):
        ln = lines[int(g.eline[sa[k]])]
        if ln.emit:
            drops.setdefault(int(g.eline[sa[k]]), (ln.id, ln.kind, round(float(sgap[k]), 1), round(float(sx[k])), round(float(sy[k]))))
    for li in drops:
        lines[li].emit = False
    stats["tube_drops"] = list(drops.values())
    rest = intr & inside & ~np.isin(la, list(drops))
    stats["tube_short"] = (int(rest.sum()), int((rest & foot).sum()), [
        (lines[int(la[k])].name or "?", lines[int(lb[k])].name or "?", "footprint" if foot[k] else "crossing", round(float(gap[k]), 1),
         round(float(clr_full[k]), 1), round(float(cx_[k])), round(float(cy_[k])))
        for k in np.flatnonzero(rest)[np.argsort((gap - clr_full)[rest])][:12]])
    worst = np.argsort(gap - clr)[:10]
    stats["worst_crossings"] = [
        (lines[int(g.eline[ea[w]])].name or "?", lines[int(g.eline[eb[w]])].name or "?", round(float(gap[w]), 1), round(float(clr[w]), 1), round(float(cx_[w])), round(float(cy_[w])))
        for w in worst
        if short[w]
    ]
    order = np.argsort(-np.abs(dev) * sm)[:8]
    stats["worst_surface"] = [(round(float(g.x[i])), round(float(g.y[i])), round(float(dev[i]), 1)) for i in order]
    # ramps: at-grade runs of busways and motorways more than 4 m off the ground
    ramps = []
    for ln in lines:
        if ln.bridge or ln.tunnel or not (ln.kind in (0, 7)) or len(ln.dnodes) < 2:
            continue
        d = dev[ln.dnodes]
        off = np.abs(d) > 4.0
        if not off.any():
            continue
        seg = np.hypot(*np.diff(ln.dxy if ln.dxy is not None else np.stack([g.x[ln.dnodes], g.y[ln.dnodes]], 1), axis=0).T)
        k = int(np.argmax(np.abs(d)))
        ramps.append((float(np.abs(d[k])), ln.name or f"kind {ln.kind}", round(float(g.x[ln.dnodes[k]])), round(float(g.y[ln.dnodes[k]])),
                      round(float(d[k]), 1), round(float(seg[off[:-1] | off[1:]].sum()))))
    stats["ramps"] = sorted(ramps, reverse=True)
    stats["graph"] = g
    stats["T"] = T
    stats["z"] = z
    log(f"solved in {time.time() - t0:.1f}s")
    return stats


# ---------------------------------------------------------------------------
# Output helpers


OPEN_SPAN_DZ = 2.5  # m: a surface way this far above a tunnel road passes over it
SHALLOW_CUT = 1.5  # m: a tunnel way with the ground less than this above it is in an open approach cut
BOXED_COVER = 3.4  # m: a tunnel way with the ground this far above it somewhere is boxed end to end


def _resample(xy: np.ndarray, z: np.ndarray, step: float):
    seg = np.hypot(*np.diff(xy, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    s = np.linspace(0.0, cum[-1], max(2, int(math.ceil(cum[-1] / step)) + 1))
    return np.stack([np.interp(s, cum, xy[:, 0]), np.interp(s, cum, xy[:, 1])], 1), np.interp(s, cum, z), s


def boxed_tunnels(lines: list[Line], ground) -> set[int]:
    """Tunnel ways the game boxes from end to end (exported as "tb", see
    src/world/roads.ts tubePrep): those with at least BOXED_COVER of ground,
    or of a road or railway at grade over them, above the road somewhere
    along them (a tube at its least clear height, 4.6 m, with its roof 1.2 m
    out of the ground). Elsewhere a tube is an open cutting where the ground
    is lower than its roof, but the 10 m grid, smoothed and with the
    approach roads burned in, reads the ground over a portal's last 6-18 m
    several metres too low, and a shallow box under a plaza or a lawn has
    less cover than a tube is high (the South East Busway under the Cultural
    Centre, the Inner Northern Busway under Victoria Park): the busway tubes
    opened 6-18 m inside their mapped ends, where the satellite imagery shows
    the portals. Returns line indices."""
    from scipy.spatial import cKDTree

    S, SZ = [], []
    for ln in lines:
        if ln.tunnel or ln.bridge or ln.dxy is None or len(ln.dxy) < 2:
            continue
        xy, z, _ = _resample(ln.dxy, ln.dz, 2.0)
        S.append(xy)
        SZ.append(z)
    tree = cKDTree(np.concatenate(S))
    SZ = np.concatenate(SZ)
    out: set[int] = set()
    for li, ln in enumerate(lines):
        if not ln.tunnel or ln.bridge or ln.kind == RAIL or ln.dxy is None or len(ln.dxy) < 2:
            continue
        xy, z, _ = _resample(ln.dxy, ln.dz, 2.0)
        cover = np.asarray(ground(xy[:, 0], xy[:, 1])) - z
        # (a road or railway over the carriageway: the Inner Northern Busway under the Roma Street yards)
        for k, idx in enumerate(tree.query_ball_point(xy, r=0.5 * float(ln.meta.get("w", 6.0)))):
            if idx:
                cover[k] = max(cover[k], float(SZ[idx].max()) - z[k])
        if float(cover.max()) >= BOXED_COVER:
            out.add(li)
    return out


def open_cutting_spans(lines: list[Line], ground, boxed: set[int]) -> dict[int, list[tuple[float, float]]]:
    """Stretches of surface ways that pass over a tunnel where its cutting is
    open beside them (the ground lower than the tube roof, on a tunnel that
    is not boxed end to end): bridge pieces, so they get a deck and parapets
    instead of an asphalt ribbon over the cutting (audit #8). Returns
    {line index: [(s0, s1) along ln.dxy]}."""
    from scipy.spatial import cKDTree

    t0 = time.time()
    P, Z, HW, H, B = [], [], [], [], []
    for li, ln in enumerate(lines):
        if not ln.tunnel or ln.bridge or ln.kind == RAIL or ln.dxy is None or len(ln.dxy) < 2:
            continue
        xy, z, _ = _resample(ln.dxy, ln.dz, 1.0)
        P.append(xy)
        Z.append(z)
        HW.append(np.full(len(z), 0.5 * float(ln.meta.get("w", 6.0))))
        H.append(np.full(len(z), TUBE_H + (0.6 if ln.kind == 0 else 0.0)))
        B.append(np.full(len(z), li in boxed))
    if not P:
        return {}
    TP, TZ, THW, TH = np.concatenate(P), np.concatenate(Z), np.concatenate(HW), np.concatenate(H)
    topen = (np.asarray(ground(TP[:, 0], TP[:, 1])) < TZ + TH - 1.2) & ~np.concatenate(B)
    tree = cKDTree(TP)
    hwmax = float(THW.max())
    out: dict[int, list[tuple[float, float]]] = {}
    for li, ln in enumerate(lines):
        if not ln.emit or ln.tunnel or ln.bridge or ln.kind == RAIL or ln.dxy is None or len(ln.dxy) < 2:
            continue
        hw = 0.5 * float(ln.meta.get("w", 6.0))
        if not any(tree.query_ball_point(ln.dxy, r=hw + hwmax + 4.0 + 0.5 * MAX_SEG, return_length=True)):
            continue
        xy, z, s = _resample(ln.dxy, ln.dz, 1.0)
        over = np.zeros(len(z), bool)
        beside = np.zeros(len(z), bool)
        for k, idx in enumerate(tree.query_ball_point(xy, r=hw + hwmax + 4.0)):
            if not idx:
                continue
            idx = np.asarray(idx)
            d = np.hypot(TP[idx, 0] - xy[k, 0], TP[idx, 1] - xy[k, 1])
            up = z[k] - TZ[idx] > OPEN_SPAN_DZ
            over[k] = bool(np.any(up & (d <= THW[idx] + 1.0)))
            beside[k] = bool(np.any(up & topen[idx] & (d > hw - 0.5) & (d <= hw + 0.5 * THW[idx] + 4.0)))
        if not over.any():
            continue
        spans: list[list[float]] = []
        k = 0
        while k < len(over):
            if not over[k]:
                k += 1
                continue
            k1 = k
            while k1 + 1 < len(over) and over[k1 + 1]:
                k1 += 1
            if beside[max(0, k - 8) : k1 + 9].any():
                a, b = max(0.0, s[k] - 1.0), min(s[-1], s[k1] + 1.0)
                if spans and a - spans[-1][1] < 3.0:
                    spans[-1][1] = b
                else:
                    spans.append([a, b])
            k = k1 + 1
        spans = [sp for sp in spans if sp[1] - sp[0] >= 3.0]
        if spans:
            # a piece shorter than 3 m left at either end joins the span
            if spans[0][0] < 3.0:
                spans[0][0] = 0.0
            if s[-1] - spans[-1][1] < 3.0:
                spans[-1][1] = float(s[-1])
            out[li] = [(a, b) for a, b in spans]
    n = sum(len(v) for v in out.values())
    log(f"{n} spans of {len(out)} surface ways over open tunnel cuttings become bridge pieces ({time.time() - t0:.1f}s):")
    for li, sp in out.items():
        ln = lines[li]
        x, y = ln.dxy[len(ln.dxy) // 2]
        log(f"    way {ln.id} {ln.name or 'kind %d' % ln.kind!r}: {', '.join('%.0f m' % (b - a) for a, b in sp)} near ({x:.0f}, {y:.0f})")
    return out


def split_spans(ln: Line, spans: list[tuple[float, float]]):
    """ln's dense polyline cut at the span ends: [(xy, z, dense node per vertex or -1, is span)]."""
    dn = np.asarray(ln.dnodes) if ln.dnodes is not None and len(ln.dnodes) == len(ln.dxy) else np.full(len(ln.dxy), -1)
    if not spans:
        return [(ln.dxy, ln.dz, dn, False)]
    seg = np.hypot(*np.diff(ln.dxy, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    cuts = sorted({float(c) for sp in spans for c in sp if 0.05 < c < cum[-1] - 0.05})
    xs, zs, ds, ss = list(ln.dxy), list(ln.dz), list(dn), list(cum)
    for c in cuts:
        k = int(np.searchsorted(ss, c))
        if abs(ss[k - 1] - c) < 0.05 or (k < len(ss) and abs(ss[k] - c) < 0.05):
            continue
        f = (c - ss[k - 1]) / (ss[k] - ss[k - 1])
        xs.insert(k, xs[k - 1] + (xs[k] - xs[k - 1]) * f)
        zs.insert(k, zs[k - 1] + (zs[k] - zs[k - 1]) * f)
        ds.insert(k, -1)
        ss.insert(k, c)
    X, Zz, D, S = np.asarray(xs), np.asarray(zs), np.asarray(ds), np.asarray(ss)
    bounds = [0.0] + cuts + [float(S[-1])]
    out = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        sel = np.flatnonzero((S >= a - 0.05) & (S <= b + 0.05))
        if len(sel) < 2:
            continue
        mid = 0.5 * (a + b)
        out.append((X[sel], Zz[sel], D[sel], any(sa <= mid <= sb for sa, sb in spans)))
    return out


def clip_polyline(xy: np.ndarray, z: np.ndarray, box: tuple[float, float, float, float]):
    """Clip a 3D polyline to an axis-aligned box (Liang-Barsky per segment).

    Returns a list of (xy, z, src) runs inside the box; src is the input
    vertex index of each run vertex, or -1 where the box cut a segment."""
    x0, y0, x1, y1 = box
    inside = (xy[:, 0] >= x0) & (xy[:, 0] <= x1) & (xy[:, 1] >= y0) & (xy[:, 1] <= y1)
    if inside.all():
        return [(xy, z, np.arange(len(xy)))]
    runs = []
    cur_xy: list = []
    cur_z: list = []
    cur_i: list = []

    def flush():
        if len(cur_xy) >= 2:
            runs.append((np.asarray(cur_xy), np.asarray(cur_z), np.asarray(cur_i)))

    for k in range(len(xy) - 1):
        ax, ay = xy[k]
        bx, by = xy[k + 1]
        dx, dy = bx - ax, by - ay
        u0, u1 = 0.0, 1.0
        ok = True
        for p, qq in ((-dx, ax - x0), (dx, x1 - ax), (-dy, ay - y0), (dy, y1 - ay)):
            if p == 0:
                if qq < 0:
                    ok = False
                    break
            else:
                r = qq / p
                if p < 0:
                    u0 = max(u0, r)
                else:
                    u1 = min(u1, r)
        if not ok or u0 > u1:
            flush()
            cur_xy, cur_z, cur_i = [], [], []
            continue
        za, zb = z[k], z[k + 1]
        pa = (ax + dx * u0, ay + dy * u0, za + (zb - za) * u0)
        pb = (ax + dx * u1, ay + dy * u1, za + (zb - za) * u1)
        if not cur_xy or u0 > 0:
            flush()
            cur_xy, cur_z, cur_i = [(pa[0], pa[1])], [pa[2]], [k if u0 == 0 else -1]
        cur_xy.append((pb[0], pb[1]))
        cur_z.append(pb[2])
        cur_i.append(k + 1 if u1 == 1 else -1)
        if u1 < 1:
            flush()
            cur_xy, cur_z, cur_i = [], [], []
    flush()
    return runs


def simplify3d(xy: np.ndarray, z: np.ndarray, tol: float, ztol: float, must: np.ndarray | None = None) -> np.ndarray:
    """Douglas-Peucker on plan position (tol) and height (ztol). Returns kept indices.

    must: optional boolean mask of vertices that are always kept."""
    n = len(xy)
    keep = np.zeros(n, bool) if must is None else must.copy()
    keep[0] = keep[-1] = True
    fixed = np.flatnonzero(keep)
    stack = [(int(a), int(b)) for a, b in zip(fixed[:-1], fixed[1:])]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        P = xy[a + 1 : b]
        A = xy[a]
        AB = xy[b] - A
        L2 = float(AB @ AB)
        if L2 < 1e-12:
            t = np.zeros(len(P))
            d = np.hypot(P[:, 0] - A[0], P[:, 1] - A[1])
        else:
            t = np.clip(((P - A) @ AB) / L2, 0.0, 1.0)
            d = np.hypot(P[:, 0] - (A[0] + t * AB[0]), P[:, 1] - (A[1] + t * AB[1]))
        # height error against linear interpolation by distance along the chord
        ez = np.abs(z[a + 1 : b] - (z[a] + t * (z[b] - z[a])))
        e = np.maximum(d / tol, ez / ztol)
        k = int(np.argmax(e))
        if e[k] > 1.0:
            m = a + 1 + k
            keep[m] = True
            stack.append((a, m))
            stack.append((m, b))
    return np.flatnonzero(keep)


def polyline_length(xy: np.ndarray) -> float:
    return float(np.hypot(*np.diff(xy, axis=0).T).sum()) if len(xy) > 1 else 0.0


def burn(ground, segments, water_mask: np.ndarray) -> np.ndarray:
    """Cut and fill the ground under at-grade roads and rail.

    ground:   build_terrain.Grid (a modified copy of its heights is returned)
    segments: list of (xy (N,2), z (N,), half_width) polylines at grade
    Under the carriageway the ground takes the road height; beyond it an
    embankment or cutting slopes back to the natural ground at about 1:2.
    """
    h0 = ground.h.astype(np.float64)
    best_w = np.zeros_like(h0)
    best_z = np.zeros_like(h0)
    best_d = np.full(h0.shape, np.inf)
    cell = ground.cell
    ny, nx = h0.shape
    for xy, z, hw in segments:
        if len(xy) < 2:
            continue
        gz = ground.sample(xy[:, 0], xy[:, 1])
        for k in range(len(xy) - 1):
            ax, ay = xy[k]
            bx, by = xy[k + 1]
            za, zb = z[k], z[k + 1]
            dz = max(abs(za - gz[k]), abs(zb - gz[k + 1]))
            reach = hw + max(4.0, min(40.0, 2.0 * dz + 2.0))
            i0 = max(0, int(math.floor((min(ax, bx) - reach - ground.x0) / cell)))
            i1 = min(nx - 1, int(math.ceil((max(ax, bx) + reach - ground.x0) / cell)))
            j0 = max(0, int(math.floor((min(ay, by) - reach - ground.y0) / cell)))
            j1 = min(ny - 1, int(math.ceil((max(ay, by) + reach - ground.y0) / cell)))
            if i1 < i0 or j1 < j0:
                continue
            xs = ground.x0 + np.arange(i0, i1 + 1) * cell
            ys = ground.y0 + np.arange(j0, j1 + 1) * cell
            X, Y = np.meshgrid(xs, ys)
            dx, dy = bx - ax, by - ay
            l2 = dx * dx + dy * dy
            t = np.clip(((X - ax) * dx + (Y - ay) * dy) / l2, 0, 1) if l2 > 1e-9 else np.zeros_like(X)
            d = np.hypot(X - (ax + t * dx), Y - (ay + t * dy))
            zz = za + (zb - za) * t
            hloc = h0[j0 : j1 + 1, i0 : i1 + 1]
            batter = np.maximum(4.0, np.minimum(40.0, 2.0 * np.abs(zz - hloc) + 2.0))
            u = np.clip((d - hw) / batter, 0, 1)
            w = 1.0 - u * u * (3 - 2 * u)
            sl = (slice(j0, j1 + 1), slice(i0, i1 + 1))
            bw = best_w[sl]
            bd = best_d[sl]
            better = ((w > bw + 1e-6) | ((np.abs(w - bw) <= 1e-6) & (d < bd))) & (w > 0)
            bw[better] = w[better]
            bd[better] = d[better]
            best_z[sl][better] = zz[better]
    out = h0 + best_w * (best_z - h0)
    out[water_mask] = h0[water_mask]
    return out.astype(np.float32)


def q(v: float) -> int:
    return int(round(float(v) * 10))


def flat(xy: np.ndarray) -> list[int]:
    return [int(v) for v in np.rint(np.asarray(xy, dtype=np.float64) * 10).ravel()]


# ---------------------------------------------------------------------------
# The build stage called by build_osm


def build(lines: list[Line], water_out: list[dict], buildings: list[dict], areas: list[dict], box,
          platforms: list[dict] | None = None):
    """Solve heights and write terrain.bin; returns (roads, rail, platforms, buildings).

    Station platforms are normalised and the station bay carriageways added to
    the roads (stations.py) before the terrain burn. Every building gets "z"
    (decimetres AHD); each road record carries its Line as "_ln" (dropped by
    the caller before writing).
    """
    import stations
    import build_terrain as BT

    t0 = time.time()
    fine, coarse = BT.raw_dem()

    def ring(p):
        return np.asarray(p, dtype=np.float64).reshape(-1, 2) * 0.1

    water = [(ring(w["p"]), [ring(h) for h in w.get("h", [])]) for w in water_out]
    woods = [(ring(a["p"]), [ring(h) for h in a.get("h", [])]) for a in areas if a.get("k") == 2]
    blds = [(ring(b["p"]), b["h"]) for b in buildings if not b.get("pt") and not b.get("_br")]
    # The radar surface also sees bridge decks and trusses (the Story Bridge
    # reads 10+ m high at its landings): their footprints are cleaned like
    # buildings, so the ground under and beside a bridge is the real ground.
    for ln in lines:
        if not ln.bridge or len(ln.xy) < 2:
            continue
        line = shapely.LineString(ln.xy)
        if line.length < 30:
            continue
        half = (3.0 if ln.kind == RAIL else 0.5 * float(ln.meta.get("w", 8.0))) + 4.0
        poly = line.buffer(half, cap_style="flat")
        for p in getattr(poly, "geoms", [poly]):
            blds.append((np.asarray(p.exterior.coords), BRIDGE_BUMP))
    ground, level_grid, _ = BT.clean(fine, water, blds, woods)
    log(f"terrain cleaned in {time.time() - t0:.1f}s")
    wi = WaterInfo(ground, level_grid)
    zones = []
    for pl in platforms or []:
        pts = np.asarray(pl["p"], dtype=np.float64).reshape(-1, 2) * 0.1
        if pl.get("a") and len(pts) >= 3:
            zones.append(shapely.Polygon(pts).buffer(0))
        elif len(pts) >= 2:
            zones.append(shapely.LineString(pts).buffer(2.0))
    stats = solve(lines, ground.sample, wi, BT.WATER_LEVEL, box, stations=zones)

    roads: list[dict] = []
    rail: list[dict] = []
    runs = []  # (line, xy, z, bridge piece) as emitted
    junction = junction_nodes(lines, stats["graph"])
    boxed = boxed_tunnels(lines, ground.sample)
    log(f"{sum(1 for li in boxed if lines[li].emit)} tunnel ways boxed end to end")
    spans = open_cutting_spans(lines, ground.sample, boxed)
    for li, ln in enumerate(lines):
        if not ln.emit:
            continue
        for pxy, pz, pdn, piece_bridge in split_spans(ln, spans.get(li, [])):
            for xy, z, src in clip_polyline(pxy, pz, box):
                if polyline_length(xy) < 1:
                    continue
                # junctions stay exact output vertices, so connected ways agree on their height
                must = np.zeros(len(xy), bool)
                dn = np.where(src >= 0, pdn[np.maximum(src, 0)], -1)
                must[dn >= 0] = junction[dn[dn >= 0]]
                keep = simplify3d(xy, z, 0.5 if ln.kind == RAIL else 0.25, ZTOL, must)
                xy, z = xy[keep], z[keep]
                rec: dict = {}
                for k, v in ln.meta.items():
                    rec[k] = v
                    if k == "p":
                        rec["p"] = flat(xy)
                        rec["z"] = [q(v) for v in z]
                if piece_bridge:
                    rec["b"] = 1
                if li in boxed:
                    rec["tb"] = 1
                rec["_ln"] = ln
                (rail if ln.kind == RAIL else roads).append(rec)
                runs.append((ln, xy, np.rint(z * 10) / 10, piece_bridge))
    check = check_output(lines, stats, runs)

    t = time.time()
    segs = []
    nshallow = 0
    for ln, xy, z, piece_bridge in runs:
        hw = 2.0 if ln.kind == RAIL else 0.5 * float(ln.meta.get("w", 6.0)) + 0.5
        if ln.tunnel and not ln.bridge and not piece_bridge and len(xy) >= 2:
            # the open approach of a tunnel way in a shallow cut (the ground
            # less than SHALLOW_CUT above the road, short of the portal) is
            # burned like an at-grade road, so the ground there is not above
            # the carriageway (222 review #16: Eastern Busway tunnel exits)
            rx, rz, _ = _resample(np.asarray(xy, np.float64), np.asarray(z, np.float64), 4.0)
            shallow = (ground.sample(rx[:, 0], rx[:, 1]) - rz) < SHALLOW_CUT
            idx = np.flatnonzero(shallow)
            if len(idx):
                for run in np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1):
                    if len(run) >= 2:
                        segs.append((rx[run], rz[run], hw))
                        nshallow += 1
            continue
        if ln.bridge or ln.tunnel or piece_bridge:
            continue
        segs.append((xy, z, hw))
    log(f"{nshallow} shallow open approaches of tunnel ways burned like at-grade roads")
    platforms, buildings, bays, bay_segs = stations.build(roads, platforms or [], buildings)
    roads.extend(bays)
    segs.extend(bay_segs)
    # walled station cuttings: their carriageways are not burned in (the grid keeps the streets' level
    # up to the walls; the floor is the cutting's own)
    cuts = stations.station_cuts(roads, platforms)
    segs, ncut = drop_in_cuts(segs, cuts)
    log(f"{ncut} at-grade polylines left out of the burn inside {len(cuts)} walled station cuttings")
    burned = BT.Grid(burn(ground, segs, np.isfinite(level_grid)), ground.x0, ground.y0, ground.cell)
    log(f"burned {len(segs)} at-grade polylines into the terrain in {time.time() - t:.1f}s")
    BT.write(burned, BT.outer_grid(coarse, burned),
             {"roads": "inner grid has the at-grade roads and rail burned in (cuttings, embankments); ground under bridges and over tunnels is natural",
              "cuts": cuts})
    building_bases(buildings, burned, cuts)
    buildings = stations.bridge_bases(buildings, roads, rail)
    buildings = stations.roof_bases(buildings, roads, platforms)
    report(stats, check)
    log(f"elevation stage done in {time.time() - t0:.1f}s")
    return roads, rail, platforms, buildings


def drop_in_cuts(segs, cuts: list[dict]):
    """The burn polylines (xy, z, half width) with their stretches inside a walled station cutting's
    outline left out: (kept polylines, how many were cut short)."""
    import build_terrain as BT

    if not cuts:
        return segs, 0
    rings = [np.asarray(c["p"], dtype=np.float64).reshape(-1, 2) * 0.1 for c in cuts]
    lo = np.min([r.min(0) for r in rings], axis=0)
    hi = np.max([r.max(0) for r in rings], axis=0)
    out = []
    n = 0
    for xy, z, hw in segs:
        xy = np.asarray(xy, dtype=np.float64)
        z = np.asarray(z, dtype=np.float64)
        if len(xy) < 2 or (xy.max(0) < lo).any() or (xy.min(0) > hi).any():
            out.append((xy, z, hw))
            continue
        rx, rz, _ = _resample(xy, z, 1.0)
        inside = np.isfinite(BT.cut_floor(cuts, rx[:, 0], rx[:, 1]))
        if not inside.any():
            out.append((xy, z, hw))
            continue
        n += 1
        keep = np.flatnonzero(~inside)
        if len(keep):
            for run in np.split(keep, np.flatnonzero(np.diff(keep) > 1) + 1):
                if len(run) >= 2:
                    out.append((rx[run], rz[run], hw))
    return out, n


def building_bases(buildings: list[dict], grid, cuts: list[dict] | None = None) -> None:
    """b["z"]: terrain at the footprint centroid (dm), or the floor of the walled station
    cutting it stands in. Building parts take the base of the outline that contains them, so
    towers sit on their podiums."""
    if not buildings:
        return
    polys = np.asarray([shapely.Polygon(np.asarray(b["p"], dtype=np.float64).reshape(-1, 2) * 0.1) for b in buildings], dtype=object)
    cen = shapely.centroid(polys)
    cx, cy = shapely.get_x(cen), shapely.get_y(cen)
    bad = ~np.isfinite(cx)
    if bad.any():  # degenerate rings: vertex mean
        for i in np.flatnonzero(bad):
            p = np.asarray(buildings[i]["p"], dtype=np.float64).reshape(-1, 2) * 0.1
            cx[i], cy[i] = p.mean(axis=0)
        cen = shapely.points(np.stack([cx, cy], 1))
    z = grid.sample(cx, cy)
    if cuts:
        import build_terrain as BT

        fz = BT.cut_floor(cuts, cx, cy)
        z = np.where(np.isfinite(fz), fz, z)
    part = np.asarray([bool(b.get("pt")) for b in buildings])
    if part.any() and (~part).any():
        outl = np.flatnonzero(~part)
        pidx = np.flatnonzero(part)
        tree = shapely.STRtree(polys[outl])
        pi, oi = tree.query(cen[pidx], predicate="within")
        first = np.unique(pi, return_index=True)[1]
        z[pidx[pi[first]]] = z[outl[oi[first]]]
    for b, v in zip(buildings, z):
        b["z"] = q(v)


def junction_nodes(lines: list[Line], g: Graph) -> np.ndarray:
    """Graph nodes that are OSM nodes shared by two or more emitted ways (or used twice by one)."""
    users = np.zeros(g.n, np.int64)
    for ln in lines:
        if ln.emit:
            np.add.at(users, ln.dnodes, 1)
    return (users >= 2) & (g.osm >= 0)


def check_output(lines: list[Line], stats: dict, runs) -> dict:
    """Junction agreement and grades measured on the emitted (simplified, quantised) polylines."""
    g: Graph = stats["graph"]
    zs = stats["z"]
    junction = junction_nodes(lines, g)
    zmin = np.full(g.n, np.inf)
    zmax = np.full(g.n, -np.inf)
    worst_err = 0.0
    out_grade: dict[str, float] = {}
    group = {k: nm for nm, ks in KIND_GROUPS for k in ks}
    for ln, xy, z, _ in runs:
        seg = np.hypot(*np.diff(xy, axis=0).T)
        cum = np.concatenate([[0.0], np.cumsum(seg)])
        long_ = seg >= 10.0
        if long_.any():
            gr = float((np.abs(np.diff(z)) / np.maximum(seg, 1e-6))[long_].max())
            nm = "*_link ramps" if ln.link else group[ln.kind]
            out_grade[nm] = max(out_grade.get(nm, 0.0), gr)
        nodes = np.unique(ln.dnodes[junction[ln.dnodes]])
        if not len(nodes):
            continue
        ls = shapely.LineString(xy)
        pts = shapely.points(np.stack([g.x[nodes], g.y[nodes]], 1))
        on = shapely.distance(ls, pts) < 0.5
        if not on.any():
            continue
        s = shapely.line_locate_point(ls, pts[on])
        zo = np.interp(s, cum, z)
        nd = nodes[on]
        worst_err = max(worst_err, float(np.abs(zo - zs[nd]).max()))
        np.minimum.at(zmin, nd, zo)
        np.maximum.at(zmax, nd, zo)
    seen = np.isfinite(zmin) & np.isfinite(zmax)
    spread = np.where(seen, zmax - zmin, 0.0)
    multi = seen & junction
    return {
        "junctions": int(multi.sum()),
        "junction_spread_max": float(spread[multi].max()) if multi.any() else 0.0,
        "junctions_over_0.15m": int((spread[multi] > 0.15).sum()),
        "output_vs_solve_max": worst_err,
        "output_grade": out_grade,
    }


def report(stats: dict, check: dict) -> None:
    log("river bridges (name, mid x, mid y, water span m, max distance from land m, crest m AHD, ways):")
    for row in stats["river_bridges"]:
        log("   ", row)
    log("max grade per class on the dense solve (max, 99th percentile), and on the output polylines (segments >= 10 m):")
    for k, (mx, p99) in stats["grade"].items():
        log(f"    {k:20s} {100 * mx:5.1f} %  p99 {100 * p99:4.1f} %   output {100 * check['output_grade'].get(k, 0.0):5.1f} %")
    md, p99, mx = stats["surface_dev"]
    log(f"at-grade deviation from the ground: median {md:.2f} m, p99 {p99:.2f} m, max {mx:.1f} m; worst at {stats['worst_surface'][:4]}")
    log("largest busway/motorway embankments (+) and cuttings (-) at grade, i.e. approach ramps (name, x, y, m, length > 4 m off):")
    for row in stats["ramps"][:25]:
        log("   ", row[1:])
    nc, short, mn, med = stats["crossings"]
    log(f"grade-separated crossings in the map: {nc}; short of clearance by > 0.3 m: {short} (median shortfall {med:.1f} m, worst {mn:+.1f} m); conflicting nodes {stats['conflicts']}")
    for row in stats["worst_crossings"]:
        log("    short:", row)
    log(f"minor unnamed ways dropped from the output for running inside a tunnel tube: {len(stats.get('tube_drops', []))}")
    for row in stats.get("tube_drops", []):
        log("    dropped (osm id, kind, gap, x, y):", row)
    ns, nf, rows = stats.get("tube_short", (0, 0, []))
    log(f"ways still less than tube + roof above a tunnel: {ns} ({nf} off the centreline)")
    for row in rows:
        log("    inside tube:", row)
    log(
        f"junctions shared by 2+ output ways: {check['junctions']}, max height disagreement {check['junction_spread_max']:.2f} m "
        f"({check['junctions_over_0.15m']} over 0.15 m); output vs solve max {check['output_vs_solve_max']:.2f} m"
    )


# ---------------------------------------------------------------------------
# Matching other geometry (bus routes) onto the solved roads


class RoadHeights:
    """The road segments of roads.json with their heights, for map matching."""

    def __init__(self, roads: list[dict]):
        ax, ay, bx, by, za, zb, rid, ow, tn = [], [], [], [], [], [], [], [], []
        for k, r in enumerate(roads):
            if "z" not in r:
                continue
            ow.append(np.full(len(r["p"]) // 2 - 1, bool(r.get("o"))))
            tn.append(np.full(len(r["p"]) // 2 - 1, bool(r.get("t"))))
            p = np.asarray(r["p"], dtype=np.float64).reshape(-1, 2) * 0.1
            z = np.asarray(r["z"], dtype=np.float64) * 0.1
            ax.append(p[:-1, 0])
            ay.append(p[:-1, 1])
            bx.append(p[1:, 0])
            by.append(p[1:, 1])
            za.append(z[:-1])
            zb.append(z[1:])
            rid.append(np.full(len(p) - 1, k))
        self.ax, self.ay, self.bx, self.by = (np.concatenate(v) for v in (ax, ay, bx, by))
        self.za, self.zb = np.concatenate(za), np.concatenate(zb)
        self.rid = np.concatenate(rid)
        self.oneway = np.concatenate(ow)
        self.tunnel = np.concatenate(tn)
        segs = shapely.linestrings(np.stack([np.stack([self.ax, self.ay], -1), np.stack([self.bx, self.by], -1)], 1))
        self.tree = shapely.STRtree(segs)

    def match(self, xy: np.ndarray, ground, radius: float = 18.0, seg_out: np.ndarray | None = None) -> tuple[np.ndarray, float]:
        """Heights along a densely sampled polyline driven on the roads.

        A Viterbi pass over the candidate road segments near each sample:
        close, parallel segments are cheap, and the height may only change as
        fast as a road can climb, so a route on a viaduct stays up and one in
        a tunnel stays down even where other roads cross above or below it.
        Samples with no road nearby hold their height (drifting towards the
        ground at 4 %). Returns (z per sample, fraction of samples off-road);
        seg_out (int array, len(xy)) receives the matched segment of each
        sample, -1 off-road.
        """
        n = len(xy)
        tang = np.zeros_like(xy)
        tang[1:-1] = xy[2:] - xy[:-2]
        tang[0] = xy[1] - xy[0]
        tang[-1] = xy[-1] - xy[-2]
        tang /= np.maximum(np.hypot(tang[:, 0], tang[:, 1]), 1e-9)[:, None]
        step = np.concatenate([[0.0], np.hypot(*np.diff(xy, axis=0).T)])
        Tz = np.asarray(ground(xy[:, 0], xy[:, 1]), dtype=np.float64)

        pi, si = self.tree.query(shapely.points(xy), predicate="dwithin", distance=radius)
        order = np.lexsort((si, pi))
        pi, si = pi[order], si[order]
        px, py = xy[pi, 0], xy[pi, 1]
        dx, dy = self.bx[si] - self.ax[si], self.by[si] - self.ay[si]
        l2 = np.maximum(dx * dx + dy * dy, 1e-9)
        t = np.clip(((px - self.ax[si]) * dx + (py - self.ay[si]) * dy) / l2, 0, 1)
        d = np.hypot(px - (self.ax[si] + t * dx), py - (self.ay[si] + t * dy))
        zc = self.za[si] + (self.zb[si] - self.za[si]) * t
        sdot = (dx * tang[pi, 0] + dy * tang[pi, 1]) / np.sqrt(l2)
        cosang = np.abs(sdot)
        # driving a one-way road backwards is not a match (twin tunnel tubes,
        # one-way pairs at different heights: 199 review #1)
        emis = (d / 7.0) ** 2 + 3.0 * (1.0 - cosang) + ONEWAY_AGAINST * (self.oneway[si] & (sdot < -0.3))
        rc = self.rid[si]
        starts = np.searchsorted(pi, np.arange(n + 1))

        FREE = 5.0  # per-sample cost of being off the mapped roads
        JUMP = 40.0  # per metre of height change beyond what a road could climb
        backs: list[np.ndarray] = []
        zs: list[np.ndarray] = []
        cost = np.zeros(1)
        prev_z = np.zeros(1)
        prev_r = np.full(1, -1)
        for k in range(n):
            a, b = starts[k], starts[k + 1]
            cz = np.append(zc[a:b], 0.0)
            cr = np.append(rc[a:b], -1)
            ce = np.append(emis[a:b], FREE)
            if k == 0:
                cz[-1] = Tz[0]
                new = ce.copy()
                bp = np.zeros(len(cz), np.int64)
            else:
                allow = 0.3 + 0.12 * step[k]
                tr = JUMP * np.maximum(0.0, np.abs(cz[:-1, None] - prev_z[None, :]) - allow)
                tr += 0.2 * (cr[:-1, None] != prev_r[None, :])
                tot = cost[None, :] + tr
                j = np.argmin(tot, axis=1)
                new = np.empty(len(cz))
                new[:-1] = tot[np.arange(len(j)), j] + ce[:-1]
                jf = int(np.argmin(cost))
                lim = 0.04 * step[k]
                cz[-1] = prev_z[jf] + np.clip(Tz[k] - prev_z[jf], -lim, lim)
                new[-1] = cost[jf] + FREE
                bp = np.append(j, jf)
            cost = new - new.min()
            prev_z, prev_r = cz, cr
            backs.append(bp)
            zs.append(cz)
        out = np.empty(n)
        off = 0
        s = int(np.argmin(cost))
        for k in range(n - 1, -1, -1):
            out[k] = zs[k][s]
            off += s == len(zs[k]) - 1
            if seg_out is not None:
                seg_out[k] = -1 if s == len(zs[k]) - 1 else int(si[starts[k] + s])
            s = int(backs[k][s])
        # smooth the small steps between parallel candidates
        if n >= 5:
            ker = np.array([1, 2, 3, 2, 1], float) / 9.0
            pad = np.concatenate([[out[0]] * 2, out, [out[-1]] * 2])
            out = np.convolve(pad, ker, mode="valid")
        return out, off / max(n, 1)


    def snap_wrong_way(self, xy: np.ndarray, z: np.ndarray, seg: np.ndarray, blend: int = 6) -> tuple[np.ndarray, int]:
        """Move route samples onto the tunnel tube their heights came from where
        the GTFS line runs nearer a one-way road going the other way at another
        level (twin tubes such as Ivory St's: 199 #1). The height match already
        picks the right tube; with the plan left over the wrong one, the guide
        lane follows the wrong tube. Only tunnels: GTFS lines in tubes are
        often straight chords between the portals, while on the surface they
        follow the street. Runs of moved samples blend back to the line over
        `blend` samples, or 8 m per metre of offset if longer.
        Returns (new xy, samples moved)."""
        n = len(xy)
        tang = np.zeros_like(xy)
        tang[1:-1] = xy[2:] - xy[:-2]
        tang[0] = xy[1] - xy[0]
        tang[-1] = xy[-1] - xy[-2]
        tang /= np.maximum(np.hypot(tang[:, 0], tang[:, 1]), 1e-9)[:, None]
        off = np.zeros_like(xy)
        mark = np.zeros(n, bool)
        for k in np.flatnonzero(seg >= 0):
            sg = int(seg[k])
            if not self.oneway[sg] or not self.tunnel[sg]:
                continue
            dx, dy = self.bx[sg] - self.ax[sg], self.by[sg] - self.ay[sg]
            L = math.hypot(dx, dy)
            if L < 1e-6 or (dx * tang[k, 0] + dy * tang[k, 1]) / L < 0.3:
                continue
            t = min(1.0, max(0.0, ((xy[k, 0] - self.ax[sg]) * dx + (xy[k, 1] - self.ay[sg]) * dy) / (L * L)))
            P = np.array([self.ax[sg] + t * dx, self.ay[sg] + t * dy])
            dc = float(np.hypot(*(P - xy[k])))
            if dc < 1.0:
                continue
            for c in self.tree.query(shapely.Point(xy[k]), predicate="dwithin", distance=dc - 0.5):
                c = int(c)
                if c == sg or not self.oneway[c] or self.rid[c] == self.rid[sg]:
                    continue
                ex, ey = self.bx[c] - self.ax[c], self.by[c] - self.ay[c]
                Lc = math.hypot(ex, ey)
                if Lc < 1e-6 or (ex * tang[k, 0] + ey * tang[k, 1]) / Lc > -0.3:
                    continue
                tc = min(1.0, max(0.0, ((xy[k, 0] - self.ax[c]) * ex + (xy[k, 1] - self.ay[c]) * ey) / (Lc * Lc)))
                if abs(self.za[c] + tc * (self.zb[c] - self.za[c]) - z[k]) > 1.0:
                    mark[k] = True
                    off[k] = P - xy[k]
                    break
        if not mark.any():
            return xy, 0
        # close one- and two-sample holes, then blend each run's ends back to the line
        idx = np.flatnonzero(mark)
        for a, b in zip(idx[:-1], idx[1:]):
            if 1 < b - a <= 3:
                for k in range(a + 1, b):
                    w = (k - a) / (b - a)
                    off[k] = (1 - w) * off[a] + w * off[b]
                    mark[k] = True
        out = xy.copy()
        out[mark] += off[mark]
        idx = np.flatnonzero(mark)
        runs = np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1)
        step = float(np.median(np.hypot(*np.diff(xy, axis=0).T))) if n > 1 else 4.0
        for run in runs:
            a, b = int(run[0]), int(run[-1])
            for end, sgn in ((a, -1), (b, 1)):
                m = max(blend, int(math.ceil(8.0 * float(np.hypot(*off[end])) / max(step, 0.5))))
                for j in range(1, m + 1):
                    k = end + sgn * j
                    if k < 0 or k >= n or mark[k]:
                        break
                    out[k] += (1.0 - j / (m + 1)) * off[end]
        return out, int(mark.sum())


def densify(xy: np.ndarray, step: float) -> np.ndarray:
    """Insert points so no segment is longer than step (keeps the original vertices)."""
    out = [xy[:1]]
    for k in range(len(xy) - 1):
        a, b = xy[k], xy[k + 1]
        m = max(1, int(math.ceil(math.hypot(*(b - a)) / step)))
        f = (np.arange(1, m + 1) / m)[:, None]
        out.append(a + (b - a) * f)
    return np.concatenate(out)
