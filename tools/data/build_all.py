"""Rebuild every data file in public/data from the raw downloads.

Download first (see tools/data/README.md):
  raw/Brisbane.osm.pbf  https://download.bbbike.org/osm/bbbike/Brisbane/Brisbane.osm.pbf
  raw/SEQ_GTFS.zip      https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip
"""

import build_osm
import build_routes

build_osm.main()
build_routes.main()
