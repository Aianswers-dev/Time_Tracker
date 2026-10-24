# Data pipeline

The game ships pre-built JSON in `public/data/`. Rebuild it from the raw
open-data downloads with:

```sh
pip install osmium shapely
mkdir -p tools/data/raw
curl -o tools/data/raw/Brisbane.osm.pbf https://download.bbbike.org/osm/bbbike/Brisbane/Brisbane.osm.pbf
curl -o tools/data/raw/SEQ_GTFS.zip    https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip
pnpm data
```

| Output | Source | Contents |
| --- | --- | --- |
| `roads.json` | OpenStreetMap | roads (kind, width, lanes, one-way, bridge, tunnel, name, speed limit), rail, traffic signals, crossings |
| `buildings.json` | OpenStreetMap | footprints with heights, building type, colours, roof shape |
| `areas.json` | OpenStreetMap | Brisbane River and other water, parks, woods, sport fields, mapped trees |
| `routes.json` | TransLink GTFS | every bus route-direction that runs ≥ 1.2 km inside the map: the most common shape, clipped to the map, with its stops and scheduled times |

Coordinates are decimetre integers on a local plane centred on King George
Square (see `common.py`). The map covers lon 152.975–153.075, lat
-27.515–-27.425: the CBD, South Brisbane, West End, Fortitude Valley, New Farm,
Kangaroo Point, Woolloongabba, Spring Hill, Paddington, Milton, Toowong, St
Lucia, Herston, Newstead, Bowen Hills, East Brisbane and nearby.

Map data © OpenStreetMap contributors (ODbL). Timetable data © State of
Queensland (Department of Transport and Main Roads), CC BY 4.0.
