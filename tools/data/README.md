# Data pipeline

The game ships pre-built data in `public/data/`. Rebuild it from the raw
open-data downloads with:

```sh
pip install osmium shapely numpy scipy pillow
mkdir -p tools/data/raw
curl -o tools/data/raw/Brisbane.osm.pbf https://download.bbbike.org/osm/bbbike/Brisbane/Brisbane.osm.pbf
curl -o tools/data/raw/SEQ_GTFS.zip    https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip
pnpm data        # python3 tools/data/build_all.py, about 3 minutes
```

The terrain tiles are fetched on the first run (about 60 PNGs) and cached in
`tools/data/raw/terrain/`. `build_all.py` runs, in order: the raw terrain
(`build_terrain.py`), the OpenStreetMap extract followed by the elevation stage
(`build_osm.py` calling `elevation.build`), then the bus routes
(`build_routes.py`, which matches route heights onto the solved roads).

| Output | Source | Contents |
| --- | --- | --- |
| `roads.json` | OpenStreetMap | roads (kind, width, lanes, one-way, bridge, tunnel, name, speed limit) and rail, with per-vertex heights; traffic signals, crossings |
| `buildings.json` | OpenStreetMap + terrain | footprints with heights, building type, colours, roof shape, base height |
| `areas.json` | OpenStreetMap | Brisbane River and other water, parks, woods, sport fields, mapped trees |
| `routes.json` | TransLink GTFS | every bus route-direction that runs ≥ 1.2 km inside the map: the most common shape, clipped to the map, with per-vertex heights, its stops (with heights) and scheduled times |
| `terrain.bin` + `terrain.json` | Terrain Tiles + OpenStreetMap | ground height grids (below) |

Coordinates are decimetre integers on a local plane centred on King George
Square (see `common.py`): x east, y north. The map covers lon 152.975–153.075,
lat -27.515–-27.425: the CBD, South Brisbane, West End, Fortitude Valley, New
Farm, Kangaroo Point, Woolloongabba, Spring Hill, Paddington, Milton, Toowong,
St Lucia, Herston, Newstead, Bowen Hills, East Brisbane and nearby.

## Heights

All heights are metres AHD (Australian Height Datum, about mean sea level).
The Brisbane River and tidal creeks are at `waterLevel` (+0.5 m) in
`terrain.json`; their beds are below it.

* **`roads.json` road and rail `"z"`**: one integer per vertex, in
  decimetres (`z * 0.1` metres), same vertex count as `"p"`. It is the
  carriageway (or rail) surface: at-grade roads follow the ground,
  bridges carry their deck, tunnels are below ground. Ways that share an
  OSM node always have a vertex there with the same `z`; a crossing without
  a shared node is grade separated (5.5 m road over road, 7 m over rail,
  4.5 m over pedestrian streets and car-park lanes).
* **`buildings.json` `"z"`**: base height of the building in decimetres,
  the ground at the footprint centroid (building parts take the base of the
  outline they stand in). `h` and `m` stay heights above that base.
* **`routes.json` route `"z"`** (per vertex, decimetres) and **stop `"z"`**:
  the route matched onto the roads it drives along at a continuous height,
  so a route through the busway tunnels stays underground and one on a
  viaduct stays up (within 0.5 m of the road surface).

The road heights come from `elevation.py`: a sparse least-squares solve over
the whole OSM road and rail network that follows the terrain, keeps grades
under 6 % (motorways, busways), 7 % (trunk), 8 % (arterials, `*_link` ramps),
10 % (tertiary), 12 % (residential, pedestrian), 15 % (service lanes) and
3.5 % (rail), lifts bridges over what they cross (river bridges at their real
deck heights: Story Bridge about 30 m, Captain Cook about 20 m, the others
12-15 m) and sinks tunnels 6 m below the ground at their portals and 7.5 m
further in (Clem7 reaches about -46 m under the river), with ramps on the
untagged approaches. `TAG_OVERRIDES` in `build_osm.py` corrects OSM tags by
way id when a structure is mapped wrongly. Check the result with

```sh
python3 tools/data/elevation_preview.py --out /tmp/preview
```

which prints spot heights, a walk along routes M1, M2 and 222 and an audit
of every grade-separated crossing on the busways and motorways, and draws
hillshaded maps and route profiles.

### `terrain.bin` / `terrain.json`

`terrain.json` describes the binary file:

```json
{ "version": 1, "units": "m AHD", "encoding": "uint16le", "scale": 0.02, "offset": -100.0,
  "waterLevel": 0.5,
  "grids": [
    { "name": "inner", "x0": -5100.0, "y0": -5440.0, "cell": 10.0, "nx": 1050, "ny": 1064, "byteOffset": 0 },
    { "name": "outer", "x0": -16800.0, "y0": -17160.0, "cell": 60.0, "nx": 566, "ny": 569, "byteOffset": 2234400 } ] }
```

Each grid is `nx * ny` little-endian uint16 samples, row-major from the
south-west corner: sample `(i, j)` (column `i`, row `j`) is at world
`x = x0 + i * cell`, `y = y0 + j * cell` metres and stores
`height = sample * scale + offset` metres AHD. The inner grid (10 m) covers
the map plus 300 m; the outer grid (60 m, out to about 12 km: Mt Coot-tha and
the horizon) covers the inner one too, with the same heights blended in, so
use the inner grid where it exists. Interpolate bilinearly. The inner grid
has the at-grade roads and rail burned in (cuttings and embankments), so the
ground meets the road surfaces; it is untouched under bridges and over
tunnels. Building and tree bumps are removed from the radar surface model.

## Sources and attribution

Map data © OpenStreetMap contributors (ODbL). Timetable data © State of
Queensland (Department of Transport and Main Roads), CC BY 4.0. Terrain:
[Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen /
Tilezen, AWS Open Data, Terrarium encoding,
`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`);
the [required attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
for this area is: Australia terrain data © Commonwealth of Australia
(Geoscience Australia) 2017; SRTM and GMTED2010 terrain data courtesy of the
U.S. Geological Survey; ETOPO1 terrain data U.S. National Oceanic and
Atmospheric Administration.
