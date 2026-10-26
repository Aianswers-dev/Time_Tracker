"""Terrain heightmap from the Mapzen / AWS Terrarium elevation tiles.

Input:  https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
        (cached in tools/data/raw/terrain/), plus the water polygons and
        building footprints from public/data/areas.json / buildings.json
Output: public/data/terrain.bin + terrain.json

Heights are metres AHD (Australian Height Datum, roughly mean sea level).
In Brisbane the tiles come from SRTM, a ~30 m radar *surface* model, so the
raw data has bumps where towers and tree canopy are, and a noisy river
surface. `clean()` turns it into a bare-earth-ish ground:

  * fills the few bad pixels,
  * removes building and canopy bumps with a morphological opening that is
    blended in where buildings are dense (CBD, Fortitude Valley) and more
    gently everywhere else, and among dense towers pulls the ground down to
    the street-level gaps between them,
  * smooths the radar noise (land only, so the river does not drag the
    banks down),
  * flattens every water polygon to a constant level (the river and tidal
    creeks to WATER_LEVEL, ponds to their own level) with a shallow bed
    below it.

Running this file on its own writes a quick terrain.bin from the polygons of
the last build_osm run. The real build is build_osm.py: elevation.build()
calls `clean()` with the fresh polygons (and the bridge footprints), solves
the road heights on that ground and writes terrain.bin with the at-grade
roads and rail burned in (cuttings and embankments; bridges and tunnels
leave the ground alone), so that is the file the game loads.

terrain.bin holds two grids of little-endian uint16 samples, one after the
other; height = sample * scale + offset. Each grid is row-major from the
south-west corner: sample (i, j) sits at world x = x0 + i * cell,
y = y0 + j * cell (x east, y north, metres, see common.py). See README.md.

terrain.json "cuts" lists the walled station cuttings (stations.station_cuts):
an outline and a floor plane each. The grid keeps the natural ground there
(their carriageways are not burned in); inside an outline the ground is the
floor (cut_floor, ground_sampler; src/data/cuts.ts in the game).
"""

import concurrent.futures
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from common import KX, KY, ORIGIN_LAT, ORIGIN_LON, OUT, RAW, bounds_xy

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
CACHE = os.path.join(RAW, "terrain")

Z_FINE = 14  # ~8.5 m pixels here; z15 is only an upsample of the same SRTM data
Z_COARSE = 12  # ~34 m pixels for the horizon grid
DEM_PAD = 3000.0  # metres of fine DEM kept around the map (road solve, Mt Coot-tha)
OUTER_PAD = 12000.0  # horizon grid reach beyond the map
CELL = 10.0  # inner grid spacing (m)
OUTER_CELL = 60.0  # horizon grid spacing (m)
INNER_PAD = 300.0  # inner grid emitted this far beyond the map bounds

WATER_LEVEL = 0.5  # m AHD: the Brisbane River and tidal creeks (mid tide)
SCALE = 0.02  # m per uint16 step
OFFSET = -100.0  # m at sample value 0 (range -100 .. 1210 m)

RAW_VERSION = 1
ATTRIBUTION = (
    "Terrain: Mapzen Terrain Tiles (AWS Open Data). Australia terrain data © Commonwealth of Australia "
    "(Geoscience Australia) 2017; SRTM and GMTED2010 terrain data courtesy of the U.S. Geological Survey; "
    "ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration."
)
TOWER_GAP = 4  # cells: radius of the street-level search among dense towers
TOWER_FLOOR = 1.0  # m added back to that local minimum


# ---------------------------------------------------------------------------
# Projection helpers


def unproject(x, y):
    """World metres -> (lon, lat). Inverse of common.project (works on arrays)."""
    return (np.asarray(x) / KX + ORIGIN_LON, np.asarray(y) / KY + ORIGIN_LAT)


def merc_px(lon, lat, z: int):
    """(lon, lat) -> global Web Mercator pixel coordinates at zoom z (256 px tiles)."""
    n = 256.0 * (1 << z)
    lat = np.radians(np.asarray(lat, dtype=np.float64))
    px = (np.asarray(lon, dtype=np.float64) + 180.0) / 360.0 * n
    py = (1.0 - np.arcsinh(np.tan(lat)) / math.pi) / 2.0 * n
    return px, py


# ---------------------------------------------------------------------------
# Tiles


def _tile_path(z: int, x: int, y: int) -> str:
    return os.path.join(CACHE, str(z), str(x), f"{y}.png")


def _fetch(z: int, x: int, y: int) -> str:
    path = _tile_path(z, x, y)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    url = TILE_URL.format(z=z, x=x, y=y)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
            Image.open(io.BytesIO(data)).verify()
            with open(path + ".tmp", "wb") as f:
                f.write(data)
            os.replace(path + ".tmp", path)
            return path
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return ""
            err = e
        except Exception as e:  # network hiccup or truncated image
            err = e
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"failed to download {url}: {err}")


def _decode(path: str) -> np.ndarray:
    if not path:
        return np.zeros((256, 256), np.float32)
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float64)
    return (a[..., 0] * 256.0 + a[..., 1] + a[..., 2] / 256.0 - 32768.0).astype(np.float32)


def mosaic(z: int, lon0: float, lat0: float, lon1: float, lat1: float):
    """Download and stitch the tiles covering a lon/lat box. Returns (heights, px0, py0)."""
    px0, py1 = merc_px(lon0, lat0, z)
    px1, py0 = merc_px(lon1, lat1, z)
    tx0, tx1 = int(px0 // 256), int(px1 // 256)
    ty0, ty1 = int(py0 // 256), int(py1 // 256)
    jobs = [(z, tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
    print(f"terrain: z{z} {len(jobs)} tiles", file=sys.stderr)
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        paths = list(pool.map(lambda j: _fetch(*j), jobs))
    out = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32)
    for (zz, tx, ty), p in zip(jobs, paths):
        out[(ty - ty0) * 256 : (ty - ty0 + 1) * 256, (tx - tx0) * 256 : (tx - tx0 + 1) * 256] = _decode(p)
    return out, tx0 * 256, ty0 * 256


def _bilinear(img: np.ndarray, fx: np.ndarray, fy: np.ndarray) -> np.ndarray:
    """Sample img at fractional pixel coords (pixel centres at integer + 0.5)."""
    fx = fx - 0.5
    fy = fy - 0.5
    x0 = np.clip(np.floor(fx).astype(np.int64), 0, img.shape[1] - 2)
    y0 = np.clip(np.floor(fy).astype(np.int64), 0, img.shape[0] - 2)
    tx = np.clip(fx - x0, 0, 1)
    ty = np.clip(fy - y0, 0, 1)
    a = img[y0, x0]
    b = img[y0, x0 + 1]
    c = img[y0 + 1, x0]
    d = img[y0 + 1, x0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def _grid(z: int, x0: float, y0: float, cell: float, nx: int, ny: int) -> np.ndarray:
    xs = x0 + np.arange(nx) * cell
    ys = y0 + np.arange(ny) * cell
    lon0, lat0 = unproject(xs[0] - 2 * cell, ys[0] - 2 * cell)
    lon1, lat1 = unproject(xs[-1] + 2 * cell, ys[-1] + 2 * cell)
    img, ox, oy = mosaic(z, float(lon0), float(lat0), float(lon1), float(lat1))
    gx, gy = np.meshgrid(xs, ys)
    lon, lat = unproject(gx, gy)
    px, py = merc_px(lon, lat, z)
    return _bilinear(img, px - ox, py - oy).astype(np.float32)


class Grid:
    """A regular height grid in world metres; sample (i, j) at (x0 + i*cell, y0 + j*cell)."""

    def __init__(self, h: np.ndarray, x0: float, y0: float, cell: float):
        self.h = h
        self.x0 = float(x0)
        self.y0 = float(y0)
        self.cell = float(cell)

    @property
    def ny(self) -> int:
        return self.h.shape[0]

    @property
    def nx(self) -> int:
        return self.h.shape[1]

    def coords(self):
        return self.x0 + np.arange(self.nx) * self.cell, self.y0 + np.arange(self.ny) * self.cell

    def sample(self, x, y) -> np.ndarray:
        fx = (np.asarray(x, dtype=np.float64) - self.x0) / self.cell
        fy = (np.asarray(y, dtype=np.float64) - self.y0) / self.cell
        i0 = np.clip(np.floor(fx).astype(np.int64), 0, self.nx - 2)
        j0 = np.clip(np.floor(fy).astype(np.int64), 0, self.ny - 2)
        tx = np.clip(fx - i0, 0, 1)
        ty = np.clip(fy - j0, 0, 1)
        h = self.h
        return (h[j0, i0] * (1 - tx) + h[j0, i0 + 1] * tx) * (1 - ty) + (h[j0 + 1, i0] * (1 - tx) + h[j0 + 1, i0 + 1] * tx) * ty

    def contains(self, x, y, margin: float = 0.0) -> np.ndarray:
        x = np.asarray(x)
        y = np.asarray(y)
        return (
            (x >= self.x0 + margin)
            & (x <= self.x0 + (self.nx - 1) * self.cell - margin)
            & (y >= self.y0 + margin)
            & (y <= self.y0 + (self.ny - 1) * self.cell - margin)
        )

    def crop(self, x0: float, y0: float, x1: float, y1: float) -> "Grid":
        i0 = int(math.floor((x0 - self.x0) / self.cell))
        j0 = int(math.floor((y0 - self.y0) / self.cell))
        i1 = int(math.ceil((x1 - self.x0) / self.cell))
        j1 = int(math.ceil((y1 - self.y0) / self.cell))
        return Grid(self.h[j0 : j1 + 1, i0 : i1 + 1].copy(), self.x0 + i0 * self.cell, self.y0 + j0 * self.cell, self.cell)


# ---------------------------------------------------------------------------
# Raw DEM (cached)


def raw_dem() -> tuple[Grid, Grid]:
    """(fine 10 m grid over the map + DEM_PAD, coarse 60 m grid over the map + OUTER_PAD)."""
    bx0, by0, bx1, by1 = bounds_xy()
    path = os.path.join(CACHE, f"dem_raw_v{RAW_VERSION}.npz")
    if os.path.exists(path):
        d = np.load(path)
        f, c = d["fine"], d["coarse"]
        fm, cm = d["fine_meta"], d["coarse_meta"]
        return Grid(f, fm[0], fm[1], fm[2]), Grid(c, cm[0], cm[1], cm[2])

    def make(z, pad, cell):
        x0 = math.floor((bx0 - pad) / cell) * cell
        y0 = math.floor((by0 - pad) / cell) * cell
        nx = int(math.ceil((bx1 + pad - x0) / cell)) + 1
        ny = int(math.ceil((by1 + pad - y0) / cell)) + 1
        return Grid(_grid(z, x0, y0, cell, nx, ny), x0, y0, cell)

    fine = make(Z_FINE, DEM_PAD, CELL)
    coarse = make(Z_COARSE, OUTER_PAD, OUTER_CELL)
    os.makedirs(CACHE, exist_ok=True)
    np.savez_compressed(
        path,
        fine=fine.h,
        coarse=coarse.h,
        fine_meta=np.array([fine.x0, fine.y0, fine.cell]),
        coarse_meta=np.array([coarse.x0, coarse.y0, coarse.cell]),
    )
    return fine, coarse


# ---------------------------------------------------------------------------
# Cleaning


def rasterize(grid: Grid, polys, value: int = 1, out: np.ndarray | None = None) -> np.ndarray:
    """Fill polygons into a uint8 mask aligned with grid samples.

    polys: iterable of (outer, holes) with rings as (N, 2) arrays in metres.
    """
    img = Image.new("L", (grid.nx, grid.ny), 0) if out is None else Image.fromarray(out)
    draw = ImageDraw.Draw(img)

    def px(ring):
        r = np.asarray(ring, dtype=np.float64)
        return [((x - grid.x0) / grid.cell, (y - grid.y0) / grid.cell) for x, y in r]

    for outer, holes in polys:
        if len(outer) < 3:
            continue
        draw.polygon(px(outer), fill=value)
        for h in holes:
            if len(h) >= 3:
                draw.polygon(px(h), fill=0)
    return np.asarray(img).copy()


def _disk(r: int) -> np.ndarray:
    yy, xx = np.mgrid[-r : r + 1, -r : r + 1]
    return (xx * xx + yy * yy) <= r * r + 0.5


def _smooth_masked(h: np.ndarray, mask: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian smoothing using only cells where mask is true (normalised convolution)."""
    m = mask.astype(np.float32)
    num = ndimage.gaussian_filter(h * m, sigma, mode="nearest")
    den = ndimage.gaussian_filter(m, sigma, mode="nearest")
    out = h.copy()
    ok = den > 1e-3
    out[ok] = num[ok] / den[ok]
    return out


def water_levels(grid: Grid, raw: np.ndarray, water) -> list[float]:
    """Surface level for each water polygon: the river and tidal creeks sit at
    WATER_LEVEL; ponds and lakes above the tide get their own level from the DEM."""
    levels = []
    areas = [abs(_ring_area(o)) for o, _ in water]
    biggest = int(np.argmax(areas)) if areas else -1
    for k, (outer, holes) in enumerate(water):
        if k == biggest:
            levels.append(WATER_LEVEL)
            continue
        m = rasterize(grid, [(outer, holes)]).astype(bool)
        if m.sum() < 1:
            # tiny pond, sample its centroid
            cx, cy = np.asarray(outer).mean(axis=0)
            v = float(grid.sample(cx, cy)) if grid.contains(cx, cy) else WATER_LEVEL
        else:
            # the rim is a more robust estimate than the (noisy) radar water surface
            rim = ndimage.binary_dilation(m, iterations=2) & ~m
            v = float(np.percentile(raw[rim], 25)) if rim.any() else float(np.median(raw[m]))
            v -= 0.6
        levels.append(WATER_LEVEL if v < WATER_LEVEL + 2.5 else round(v, 1))
    return levels


def _ring_area(r) -> float:
    a = np.asarray(r, dtype=np.float64)
    x, y = a[:, 0], a[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def building_height_raster(grid: Grid, buildings) -> np.ndarray:
    """Roof height (m) of the tallest building covering each sample, 0 elsewhere."""
    img = Image.new("F", (grid.nx, grid.ny), 0.0)
    draw = ImageDraw.Draw(img)
    for ring, height in sorted(buildings, key=lambda b: b[1]):
        r = np.asarray(ring, dtype=np.float64)
        if len(r) >= 3:
            draw.polygon([((x - grid.x0) / grid.cell, (y - grid.y0) / grid.cell) for x, y in r], fill=float(min(height, 250.0)))
    return np.asarray(img).astype(np.float32)


def clean(fine: Grid, water, buildings, woods=()) -> tuple[Grid, np.ndarray, list[float]]:
    """Bare-earth-ish ground from the raw radar DEM.

    water:     list of (outer, holes) rings in metres (areas.json "water")
    buildings: list of (ring, roof height m) footprints (not building:parts)
    woods:     list of (outer, holes) rings of wooded areas
    Returns (cleaned grid, water level per sample (NaN on land), per-polygon
    water levels).
    """
    h = fine.h.astype(np.float32).copy()

    # 1. bad pixels (the tiles have a few -600 m holes near tile seams)
    bad = ~np.isfinite(h) | (h < -30) | (h > 1500)
    if bad.any():
        idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
        h = h[tuple(idx)]

    raw = h.copy()

    # 2. building / canopy bumps. A grey opening (a lower envelope that drops
    # anything narrower than the disk) proposes the ground; how much of the
    # difference is removed is capped by the bump the OSM buildings (or tree
    # canopy) could actually cause there, so hilltops with only houses on them
    # keep their height while CBD towers are flattened. The radar smears tall
    # towers over their surroundings, hence the wide second blur.
    H = building_height_raster(fine, buildings) if buildings else np.zeros_like(h)
    bump = np.maximum(ndimage.gaussian_filter(H, 2.0), 0.8 * ndimage.gaussian_filter(H, 5.0))
    if woods:
        bump = np.maximum(bump, 3.0 * ndimage.gaussian_filter(rasterize(fine, woods).astype(np.float32), 2.0))
    small = np.minimum(ndimage.gaussian_filter(ndimage.grey_opening(h, footprint=_disk(6)), 2.0), h)
    large = np.minimum(ndimage.gaussian_filter(ndimage.grey_opening(h, footprint=_disk(15)), 4.0), h)
    tall = np.clip((ndimage.gaussian_filter(H, 6.0) - 6.0) / 10.0, 0.0, 1.0)  # CBD-like blocks
    opened = small * (1 - tall) + large * tall
    h = h - np.minimum(h - opened, 0.9 * bump)

    wmask = np.zeros(h.shape, np.uint8)
    levels = water_levels(fine, raw, water) if water else []
    level_grid = np.full(h.shape, np.nan, np.float32)
    for (outer, holes), lv in zip(water, levels):
        m = rasterize(fine, [(outer, holes)]).astype(bool)
        level_grid[m] = lv
        wmask |= m
    wm = wmask.astype(bool)
    land = ~wm

    # 2b. Among dense towers (the CBD, South Brisbane, the Valley) the radar
    # smears each tower over its neighbours and the street-level gaps are
    # the best ground there is: pull the ground down towards a smoothed
    # local minimum of the land (water excluded, so banks are not dragged
    # down). Only lowers, and only where the blocks are tall.
    w = ndimage.gaussian_filter(tall, 3.0)
    if (w > 0.05).any():
        ero = ndimage.grey_erosion(np.where(land, h, np.float32(1e4)), footprint=_disk(TOWER_GAP))
        ero = np.where(ero < 1e3, ero, h)
        floor = _smooth_masked(ero, land, 4.0) + TOWER_FLOOR
        h = np.where(land, np.minimum(h, h * (1 - w) + floor * w), h)

    # 3. water polygons to constant levels, land smoothed without them
    h = _smooth_masked(h, land, 1.6)
    if wm.any():
        dist = ndimage.distance_transform_edt(wm) * fine.cell
        lv = level_grid[wm]
        tidal = lv <= WATER_LEVEL + 0.01
        depth = np.where(tidal, np.minimum(6.0, 0.6 + 0.12 * dist[wm]), np.minimum(1.5, 0.3 + 0.08 * dist[wm]))
        h[wm] = lv - depth
        # banks never dip below the water they hold
        near = ndimage.binary_dilation(wm, iterations=3) & land
        if near.any():
            idx = ndimage.distance_transform_edt(~wm, return_distances=False, return_indices=True)
            lvl_near = level_grid[tuple(i[near] for i in idx)]
            h[near] = np.maximum(h[near], lvl_near + 0.4)

    return Grid(h.astype(np.float32), fine.x0, fine.y0, fine.cell), level_grid, levels


def outer_grid(coarse: Grid, fine: Grid) -> Grid:
    """Horizon grid: coarse DEM, replaced by the (processed) fine grid where it exists."""
    xs, ys = coarse.coords()
    gx, gy = np.meshgrid(xs, ys)
    inside = fine.contains(gx, gy, margin=fine.cell)
    h = coarse.h.copy()
    # light canopy removal on the horizon too
    opened = ndimage.gaussian_filter(ndimage.grey_opening(h, footprint=_disk(1)), 1.0)
    h = h - 0.35 * (h - np.minimum(opened, h))
    if inside.any():
        # block-average the fine grid (anti-aliased) then blend over 1.5 km
        k = coarse.cell / fine.cell
        smooth = Grid(ndimage.gaussian_filter(fine.h, k * 0.45), fine.x0, fine.y0, fine.cell)
        fv = smooth.sample(gx[inside], gy[inside])
        # distance from the fine grid's edge
        fx0, fy0 = fine.x0, fine.y0
        fx1 = fine.x0 + (fine.nx - 1) * fine.cell
        fy1 = fine.y0 + (fine.ny - 1) * fine.cell
        d = np.minimum.reduce([gx[inside] - fx0, fx1 - gx[inside], gy[inside] - fy0, fy1 - gy[inside]])
        t = np.clip(d / 1500.0, 0.0, 1.0)
        t = t * t * (3 - 2 * t)
        h[inside] = h[inside] * (1 - t) + fv * t
    return Grid(h.astype(np.float32), coarse.x0, coarse.y0, coarse.cell)


# ---------------------------------------------------------------------------
# Output


def encode(h: np.ndarray) -> np.ndarray:
    return np.clip(np.round((h - OFFSET) / SCALE), 0, 65535).astype("<u2")


def write(inner: Grid, outer: Grid, extra: dict | None = None) -> None:
    """Write public/data/terrain.bin + terrain.json (see module docstring)."""
    bx0, by0, bx1, by1 = bounds_xy()
    inner = inner.crop(bx0 - INNER_PAD, by0 - INNER_PAD, bx1 + INNER_PAD, by1 + INNER_PAD)
    a = encode(inner.h)
    b = encode(outer.h)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "terrain.bin"), "wb") as f:
        f.write(a.tobytes())
        f.write(b.tobytes())
    head = {
        "version": 1,
        "units": "m AHD",
        "encoding": "uint16le",
        "scale": SCALE,
        "offset": OFFSET,
        "waterLevel": WATER_LEVEL,
        "grids": [
            {"name": "inner", "x0": inner.x0, "y0": inner.y0, "cell": inner.cell, "nx": inner.nx, "ny": inner.ny, "byteOffset": 0},
            {"name": "outer", "x0": outer.x0, "y0": outer.y0, "cell": outer.cell, "nx": outer.nx, "ny": outer.ny, "byteOffset": int(a.nbytes)},
        ],
        "attribution": ATTRIBUTION,
    }
    if extra:
        head.update(extra)
    with open(os.path.join(OUT, "terrain.json"), "w") as f:
        json.dump(head, f, indent=1)
    print(f"terrain.bin {os.path.getsize(os.path.join(OUT, 'terrain.bin')) // 1024} KB "
          f"(inner {inner.nx}x{inner.ny} @ {inner.cell:g} m, outer {outer.nx}x{outer.ny} @ {outer.cell:g} m)", file=sys.stderr)


def read_terrain() -> tuple[Grid, Grid, dict]:
    """(inner, outer, header) from public/data/terrain.bin + terrain.json."""
    with open(os.path.join(OUT, "terrain.json")) as f:
        head = json.load(f)
    with open(os.path.join(OUT, "terrain.bin"), "rb") as f:
        raw = f.read()
    grids = []
    for g in head["grids"]:
        a = np.frombuffer(raw, "<u2", g["nx"] * g["ny"], g["byteOffset"]).reshape(g["ny"], g["nx"])
        grids.append(Grid(a.astype(np.float32) * head["scale"] + head["offset"], g["x0"], g["y0"], g["cell"]))
    return grids[0], grids[1], head


def cut_floor(cuts: list[dict] | None, x, y) -> np.ndarray:
    """Per point: the floor of the station cutting whose outline holds it (terrain.json "cuts":
    ring "p" in dm, floor z = a + b x + c y for "f" = [a, b, c]), NaN outside every cutting."""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    x, y = np.broadcast_arrays(x, y)
    out = np.full(x.shape, np.nan)
    for c in cuts or []:
        ring = np.asarray(c["p"], dtype=np.float64).reshape(-1, 2) * 0.1
        m = (x >= ring[:, 0].min()) & (x <= ring[:, 0].max()) & (y >= ring[:, 1].min()) & (y <= ring[:, 1].max())
        if not m.any():
            continue
        px, py = x[m], y[m]
        inside = np.zeros(px.shape, bool)
        for k in range(len(ring)):
            ax, ay = ring[k - 1]
            bx, by = ring[k]
            if ay == by:
                continue
            cross = (ay > py) != (by > py)
            xi = ax + (py - ay) * (bx - ax) / (by - ay)
            inside ^= cross & (px < xi)
        a, b, cc = c["f"]
        sub = out[m]
        sub[inside] = a + b * px[inside] + cc * py[inside]
        out[m] = sub
    return out


def ground_sampler(inner: Grid, outer: Grid, cuts: list[dict] | None = None):
    """Vectorised (x, y) -> height using the inner grid where it exists, else the outer one; the
    floor inside a station cutting's outline (terrain.json "cuts")."""

    def f(x, y):
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        g = np.where(inner.contains(x, y), inner.sample(x, y), outer.sample(x, y))
        if cuts:
            fz = cut_floor(cuts, x, y)
            g = np.where(np.isfinite(fz), fz, g)
        return g

    return f


def load_polys_from_json():
    """Water polygons and building footprints from the last build_osm run."""
    water, buildings, woods = [], [], []
    ap = os.path.join(OUT, "areas.json")
    bp = os.path.join(OUT, "buildings.json")

    def ring(p):
        return np.asarray(p, dtype=np.float64).reshape(-1, 2) * 0.1

    if os.path.exists(ap):
        with open(ap) as f:
            a = json.load(f)
        water = [(ring(w["p"]), [ring(h) for h in w.get("h", [])]) for w in a["water"]]
        woods = [(ring(w["p"]), [ring(h) for h in w.get("h", [])]) for w in a["areas"] if w.get("k") == 2]
    if os.path.exists(bp):
        with open(bp) as f:
            b = json.load(f)
        buildings = [(ring(x["p"]), x["h"]) for x in b["buildings"] if not x.get("pt")]
    return water, buildings, woods


def main():
    t = time.time()
    fine, coarse = raw_dem()
    water, buildings, woods = load_polys_from_json()
    if not water:
        print("terrain: areas.json not found, water is not flattened (run build_osm first)", file=sys.stderr)
    ground, _, levels = clean(fine, water, buildings, woods)
    write(ground, outer_grid(coarse, ground))
    print(f"terrain done in {time.time() - t:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
