# Brisbane Bus Simulator

Drive real TransLink bus routes through an accurate 3D model of Brisbane's CBD
and inner suburbs, from the driver's seat of a Transport for Brisbane bus, a
Blue or Maroon CityGlider, or a 24.7 m bi-articulated Brisbane Metro.

It runs in the browser (three.js + TypeScript + Vite). There is no server: the
map and timetable are pre-built JSON in `public/data/`.

```sh
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # static site in dist/
```

## What's in it

- **The city** from OpenStreetMap: ~16,500 road segments with real widths,
  lanes, one-ways and speed limits, ~56,000 buildings with heights, the
  Brisbane River, parks, rail lines, traffic signals and crossings. Gaps in the
  OSM house coverage are filled with procedural Queenslanders.
- **The routes** from the TransLink GTFS feed: every bus route-direction that
  runs at least 1.2 km inside the map (~386, including M1/M2, CityGlider 60/61,
  the City and Spring Hill loops, BUZ and NightLink routes), with their real
  stops and scheduled times.
- **The buses**: Volgren Optimus in the Transport for Brisbane TransLink
  livery, Blue and Maroon CityGliders, and the Brisbane Metro, each with a
  right-hand-drive cab (working speedo, tell-tales, ticketing console) and
  saloon. LED destination signs show the route you pick.
- **Real elevation**: terrain from the AWS/Mapzen terrain tiles, every road,
  bridge and tunnel at its solved height. Busway viaducts pass over the
  streets, the King George Square and Queen Street busway stations are
  underground, and the Story Bridge deck is 30 m above the river.
- **Driving**: heavy-vehicle physics with an automatic gearbox, rear-axle
  pivoting and front overhang swing, articulated Metro sections, door
  interlock, kneel, park brake, hills (with hill-start assist), staying on
  your level in tunnels and on viaducts, tunnel walls and parapets,
  collisions with buildings and traffic, and synthesised engine, air-brake,
  door and tunnel-echo sounds.
- **The shift**: pull into each stop (any lettered bay at a busway platform)
  and open the doors to serve it, keep to the timetable, follow turn-by-turn
  hints, and get a summary at the end. AI buses run their own real routes
  around you, plus car traffic (Off / Light / Normal in the menu).

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Throttle / brake | W / S or ↑ / ↓ (Shift+S emergency stop) | RT / LT |
| Steer | A / D or ← / → | Left stick |
| Gears | R reverse (when stopped), N neutral, G drive | D-pad up / down |
| Doors | O or Space | A |
| Indicators | Q / E (self-cancel) | LB / RB |
| Hazards / headlights | Z / L | R3 / D-pad left |
| Horn | H (hold) | X |
| Kneel / park brake | K / F | L3 / B |
| Camera (cab, chase, top, cinematic) | C | Y |
| Look at mirrors / back | hold , . / or drag the mouse | Right stick |
| Map / time of day / pause | M / T / P or Esc | Back / – / Start |
| Guidance chevrons | V | |
| Reset onto the road | Backspace | D-pad right |

Phones and tablets get on-screen pedals, a steering wheel and buttons (force
them with `?touch=1`).

## Dev shortcuts

`?route=61&dir=0&hours=10&cam=chase&s=800` skips the menu and starts route 61
(direction 0) at 10:00, 800 m along, in the chase camera. `cam=top` is the
overhead view. `node tools/shot/shot.mjs "<query>" out.png <waitMs> "<keys>"`
takes a headless screenshot of a running dev server.

## Layout

| Path | What |
| --- | --- |
| `src/types.ts` | The shared contract between subsystems (data, buses, driving, world) |
| `src/data/` | JSON loading and coordinate helpers |
| `src/world/` | Ground, river, roads, buildings, vegetation, street furniture, landmarks, sky |
| `src/bus/` | Bus models, liveries, destination signs, cab and saloon |
| `src/sim/` | Input, physics, collisions, cameras, audio |
| `src/game/` | Menu, route guidance and stops, HUD and maps, AI traffic |
| `tools/data/` | Python pipeline that builds `public/data/` from OSM and GTFS |

## Data and credits

Map data © OpenStreetMap contributors, ODbL. Timetable data © State of
Queensland (Department of Transport and Main Roads), CC BY 4.0. Terrain:
Mapzen Terrain Tiles (AWS Open Data); Australia terrain data © Commonwealth
of Australia (Geoscience Australia) 2017; SRTM and GMTED2010 courtesy of the
U.S. Geological Survey; ETOPO1 courtesy of NOAA. See
`tools/data/README.md` to rebuild the data.
