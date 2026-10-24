# Agent guide for Brisbane Bus Simulator

A browser bus simulator of Brisbane's CBD and inner suburbs: three.js +
TypeScript strict + Vite, no server. Read `README.md`, then `src/types.ts`
(the contract between subsystems and the coordinate conventions).

## Ground rules

- **Coordinates**: map data is metres, x east / y north, centred on King George
  Square. three.js uses x = x, z = -y. Headings are compass radians (0 north,
  clockwise). Use `src/data/coords.ts`; don't hand-roll conversions.
- **Australia drives on the left**; buses are right-hand drive.
- **Accuracy first**: map and routes come from OpenStreetMap and the TransLink
  GTFS feed via `tools/data/`. Fix data problems in the pipeline and rebuild,
  not by hand-editing `public/data/`.
- **Everything is procedural**: no runtime downloads of models, textures or
  audio. Canvas textures and synthesised audio are fine.
- **Performance**: 60 fps on a mid-range laptop in the CBD. Merge geometry,
  instance repeated objects, share materials, keep draw calls in the low
  hundreds, and keep per-frame CPU work in each subsystem around a millisecond.
- Subsystems talk through `src/types.ts` and the exports of each directory's
  `index.ts`. `src/main.ts` is the only orchestrator.

## Commands

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm build
pnpm data            # rebuild public/data (see tools/data/README.md)
npx -y tsx src/sim/selftest.ts   # physics sanity checks
```

## Checking your work

- Screenshots: start `npx vite --port 5174 --strictPort` and run
  `SHOT_URL=http://localhost:5174/ node tools/shot/shot.mjs "route=61&cam=chase" out.png 30000`.
  Headless Chromium uses SwiftShader, so it is slow; give long waits.
- Route films: `SHOT_URL=http://localhost:5174/ node tools/film/film.mjs --route M2 --dir 0 --out /tmp/f/m2`
  drives the whole route on autopilot (`?film=1`, `src/game/autopilot.ts`) and
  records cab/chase frames, mp4s and captioned contact sheets; `--fast` skips
  rendering and just logs problems (wall hits, wrong level, stuck, missed
  stops) to `report.json` in a few minutes. `?autopilot=1` lets the bus drive
  itself in a normal session.
- `src/bus/preview.html` previews bus models; `?world=debug` and `?simdebug`
  expose debug hooks on `window`.
- Stop servers by port (`fuser -k 5174/tcp`). Never `pkill -f` a pattern that
  also matches your own shell's command line.
