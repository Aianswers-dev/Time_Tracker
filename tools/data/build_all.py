"""Rebuild every data file in public/data from the raw downloads.

Download first (see tools/data/README.md):
  raw/Brisbane.osm.pbf  https://download.bbbike.org/osm/bbbike/Brisbane/Brisbane.osm.pbf
  raw/SEQ_GTFS.zip      https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip
The terrain tiles are downloaded (and cached in raw/terrain/) on first use.

Order:
  1. terrain   raw DEM from the terrain tiles (cached)
  2. osm       roads, rail, buildings, areas; then the elevation stage
               (elevation.build): terrain cleaning, road/rail height solve,
               terrain.bin with the roads burned in, building bases
  3. routes    GTFS routes and stops, heights matched onto the solved roads
"""

import time

import build_osm
import build_routes
import build_terrain

t = time.time()
build_terrain.raw_dem()
build_osm.main()
build_routes.main()
print(f"all data rebuilt in {time.time() - t:.0f}s")
