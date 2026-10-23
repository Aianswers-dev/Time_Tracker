"""Shared constants for the data pipeline.

World coordinates are metres on a local equirectangular projection centred on
the Brisbane CBD: x points east, y points north. The game maps (x, y) to
three.js as position.x = x, position.z = -y.
"""

import math
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "raw")
OUT = os.path.join(ROOT, "..", "..", "public", "data")

# Centre: King George Square / City Hall area.
ORIGIN_LAT = -27.4689
ORIGIN_LON = 153.0235

# CBD and inner suburbs (Toowong/St Lucia to Bulimba edge, Herston to Annerley).
MIN_LON, MAX_LON = 152.975, 153.075
MIN_LAT, MAX_LAT = -27.515, -27.425

R = 6378137.0
KX = math.cos(math.radians(ORIGIN_LAT)) * math.pi / 180 * R
KY = math.pi / 180 * R


def project(lon: float, lat: float) -> tuple[float, float]:
    return ((lon - ORIGIN_LON) * KX, (lat - ORIGIN_LAT) * KY)


def in_bbox(lon: float, lat: float, pad: float = 0.0) -> bool:
    return (MIN_LON - pad) <= lon <= (MAX_LON + pad) and (MIN_LAT - pad) <= lat <= (MAX_LAT + pad)


def bounds_xy() -> tuple[float, float, float, float]:
    x0, y0 = project(MIN_LON, MIN_LAT)
    x1, y1 = project(MAX_LON, MAX_LAT)
    return (x0, y0, x1, y1)


def q(v: float) -> int:
    """Quantise metres to decimetres for compact JSON."""
    return int(round(v * 10))
