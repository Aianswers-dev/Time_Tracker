import * as THREE from 'three';
import './style.css';
import { loadMapData } from './data/load';
import { headingDir } from './data/coords';
import { buildWorld } from './world';
import { busFactory } from './bus';
import { BusAudio, BusControls, BusPhysics, CameraRig, InputManager, buildCollider } from './sim';
import { Autopilot, Hud, RouteGuide, Traffic, busTypeForRoute, showMenu } from './game';
import type { ResolveResult } from './sim';

const app = document.getElementById('app')!;

function loadingScreen() {
  const el = document.createElement('div');
  el.id = 'loading';
  el.innerHTML = `<h1>Brisbane Bus Simulator</h1><div class="bar"><div></div></div><div class="label">Starting…</div>`;
  document.body.appendChild(el);
  const bar = el.querySelector<HTMLDivElement>('.bar > div')!;
  const label = el.querySelector<HTMLDivElement>('.label')!;
  return {
    set(f: number, text: string) {
      bar.style.width = `${Math.round(f * 100)}%`;
      label.textContent = text;
    },
    remove() {
      el.remove();
    },
  };
}

async function main() {
  const loading = loadingScreen();
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 6000);
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  const data = await loadMapData((f, t) => loading.set(f * 0.5, t));
  const world = await buildWorld(scene, renderer, data, (f, t) => loading.set(0.5 + f * 0.5, t));
  const collider = buildCollider(data);
  const traffic = new Traffic(scene, data, busFactory, world);
  loading.remove();

  // Render the city behind the menu.
  let menuOpen = true;
  let orbit = 0;
  const idle = () => {
    if (!menuOpen) return;
    orbit += 0.0006;
    camera.position.set(Math.sin(orbit) * 1400, 520, Math.cos(orbit) * 1400);
    camera.lookAt(0, 0, 0);
    world.update(1 / 60, camera, 17.5);
    renderer.render(scene, camera);
    requestAnimationFrame(idle);
  };
  idle();

  // Dev/test shortcut: ?route=61&dir=0&hours=10&cam=chase&s=800 skips the menu.
  const params = new URLSearchParams(location.search);
  const quick = params.get('route');
  const quickRoute = quick
    ? (data.routes.find((r) => r.id === quick && String(r.dir) === (params.get('dir') ?? '0')) ?? data.routes.find((r) => r.id === quick))
    : undefined;
  const choice = quickRoute
    ? { route: quickRoute, type: busTypeForRoute(quickRoute), hours: Number(params.get('hours') ?? 10) }
    : await showMenu(data);
  menuOpen = false;

  const route = choice.route;
  const bus = busFactory.createBus({ type: choice.type, route, detail: 'high' });
  bus.setDestination({ route: route.id, headsign: route.headsign });
  for (const s of bus.sections) scene.add(s);
  const cab = busFactory.createCab(choice.type);
  bus.sections[0].add(cab.group);

  const physics = new BusPhysics(bus.spec);
  const controls = new BusControls();
  const input = new InputManager();
  const rig = new CameraRig(camera);
  const audio = new BusAudio();
  audio.setType(choice.type);
  audio.start();
  const guide = new RouteGuide(scene, data, route, { busLength: bus.spec.sections.reduce((a, s) => a + s.length, 0), walls: collider, busType: choice.type });
  const hud = new Hud(document.body, data, { traffic, guide });
  // Player collides with buildings and with the AI buses and cars.
  const playerCollider = traffic.wrapCollider(collider);
  // ?autopilot=1 drives the route by itself; ?film=1 also stops the clock so a
  // test harness can step the sim and grab frames (window.__film).
  const film = params.has('film');
  const auto = params.has('autopilot') || film ? new Autopilot(guide.track, bus.spec, traffic) : null;
  let lastHit: ResolveResult | null = null;
  const driveCollider = auto ? Object.create(playerCollider) : playerCollider;
  if (auto)
    driveCollider.resolve = (p: Parameters<typeof playerCollider.resolve>[0], s: Parameters<typeof playerCollider.resolve>[1]) => (lastHit = playerCollider.resolve(p, s) as ResolveResult);

  // startPose gives the FRONT of the bus; physics tracks the rear axle.
  const start = guide.startPose();
  const startS = Number(params.get('s') ?? 0);
  // On the guidance lane (the raw GTFS shape can be metres off a busway tunnel, inside rock).
  if (startS > 0) Object.assign(start, guide.trackPose(startS));
  const rearOffset = bus.spec.sections[0].axleFromFront;
  const [fx, fy] = headingDir(start.heading);
  // The route height picks the level (stays in a tunnel / up on a viaduct when starting there).
  physics.reset(start.x - fx * rearOffset, start.y - fy * rearOffset, start.heading, start.z);
  auto?.reset(physics.pose);
  controls.lights.headlights = choice.hours < 6.5 || choice.hours > 18;

  for (let i = 0; i < Number(params.get('cam') === 'chase' ? 1 : params.get('cam') === 'top' ? 2 : 0); i++) rig.cycle();
  let hours = choice.hours;
  let paused = false;
  let fps = 60;
  const clock = new THREE.Clock();
  let simTime = 0;
  let splashed = false;
  let dingedStop = -1;

  /** One sim step; `draw` = also update the cab, HUD and world and render (film mode skips it between frames). */
  let worldDt = 0;
  const tick = (dt: number, draw: boolean) => {
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
    let inp = input.poll(dt);
    if (inp.pressed.has('pause')) paused = !paused;
    if (inp.pressed.has('camera')) rig.cycle();
    if (inp.pressed.has('map')) hud.toggleMap();
    if (inp.pressed.has('timeOfDay')) {
      hours = (hours + 3) % 24;
      hud.toast(`Time ${String(Math.floor(hours)).padStart(2, '0')}:00`);
    }
    if (inp.pressed.has('reset')) {
      const p = physics.pose;
      physics.reset(p.x, p.y, p.heading);
    }
    if (paused && !film) {
      renderer.render(scene, camera);
      return;
    }
    if (auto) {
      const a = auto.update({ dt, pose: physics.pose, guide: guide.state, doorsOpen: controls.doorsOpen, interlock: controls.interlock, kneel: controls.kneel, hit: lastHit ?? undefined, z: physics.pose.z });
      inp = { ...inp, throttle: a.throttle, brake: a.brake, steer: a.steer, gear: a.gear, pressed: new Set([...inp.pressed, ...a.pressed]) };
      lastHit = null;
      if (auto.rescue) {
        const r = auto.rescue;
        physics.reset(r.x, r.y, r.heading, r.z);
        auto.rescue = null;
      }
    }
    simTime += dt;
    hours = (hours + dt / 3600) % 24;

    controls.update(dt, inp, physics.pose);
    const hit = physics.update(dt, inp, controls, driveCollider);
    if (hit.impact > 1) audio.impact(hit.impact);
    guide.noteImpact(hit.impact);
    if (hit.water && !splashed) hud.toast('Splash! The bus is going back on the road…');
    splashed = !!hit.water;
    const pose = physics.pose;

    bus.setPose(pose);
    bus.setLights(controls.lights, simTime);
    bus.setDoors(controls.doorOpen);

    const [hx, hy] = headingDir(pose.heading);
    const frontX = pose.x + hx * rearOffset;
    const frontY = pose.y + hy * rearOffset;
    // Height at the front of the bus, so the guide keeps the right level under viaducts and in tunnels.
    const s0 = pose.sections[0];
    const frontZ = (s0.z ?? pose.z ?? 0) + Math.tan(s0.pitch ?? 0) * rearOffset;
    // The controls give the guide the door opening and kneel, so passengers only move with the doors fully open.
    const g = guide.update(dt, frontX, frontY, controls.doorsOpen, pose.speed, pose.heading, hours, frontZ, controls);
    // Stop-request bell once per stop as it comes within 250 m.
    if (!g.finished && g.nextStopDistance < 250 && g.nextStopIndex !== dingedStop) {
      dingedStop = g.nextStopIndex;
      audio.ding();
    }

    rig.update(dt, bus, cab, pose, inp);
    audio.update({ rpm: physics.rpm, throttle: inp.throttle, speed: pose.speed, brake: inp.brake });
    audio.horn(inp.held.has('horn'));

    traffic.update(dt, simTime, pose, camera, hours);
    worldDt += dt;
    if (!draw) return;
    cab.update({
      speedKmh: Math.abs(pose.speed) * 3.6,
      rpm: physics.rpm,
      steeringWheel: (pose.steer / bus.spec.maxSteer) * Math.PI * 1.75,
      lights: controls.lights,
      doorsOpen: controls.doorsOpen,
      stopRequested: g.nextStopDistance < 250 && !g.finished,
      timeSeconds: simTime,
      gear: inp.gear,
    });
    world.update(worldDt, camera, hours);
    worldDt = 0;
    hud.update({
      route,
      pose,
      speedKmh: Math.abs(pose.speed) * 3.6,
      rpm: physics.rpm,
      gear: inp.gear,
      lights: controls.lights,
      doorsOpen: controls.doorsOpen,
      guide: g,
      hours,
      cameraMode: rig.mode,
      fps,
      parkBrake: controls.parkBrake,
      paused,
    });
    renderer.render(scene, camera);
  };

  if (film) {
    // Test harness API: advance the sim by `seconds` in fixed steps and render the last one.
    const api = {
      ready: true,
      route: { id: route.id, dir: route.dir, headsign: route.headsign, length: route.length },
      advance(seconds: number, opts: { step?: number; draw?: boolean } = {}) {
        const step = opts.step ?? 1 / 30;
        const n = Math.max(1, Math.round(seconds / step));
        for (let i = 0; i < n; i++) tick(step, opts.draw !== false && i === n - 1);
        return api.state();
      },
      /** Put the bus on the guide lane with its front at route distance s, stopped (route tours). */
      place(s: number) {
        const p = guide.trackPose(s);
        const [px, py] = headingDir(p.heading);
        physics.reset(p.x - px * rearOffset, p.y - py * rearOffset, p.heading, p.z);
        auto?.reset(physics.pose);
        return api.state();
      },
      /** Render the current state again (after a camera change). */
      draw() {
        tick(1 / 120, true);
      },
      view(mode: 'cab' | 'chase' | 'top' | 'cinematic') {
        rig.setMode(mode);
      },
      state() {
        const p = physics.pose;
        const g = guide.state;
        const f = auto!.frame;
        return {
          t: +simTime.toFixed(2),
          s: +g.s.toFixed(1),
          length: route.length,
          x: +p.x.toFixed(1),
          y: +p.y.toFixed(1),
          z: +(p.z ?? 0).toFixed(2),
          heading: +((p.heading * 180) / Math.PI).toFixed(1),
          kmh: +(Math.abs(p.speed) * 3.6).toFixed(1),
          phase: f.phase,
          why: f.limitWhy,
          target: +(f.target * 3.6).toFixed(0),
          lateral: +f.lateral.toFixed(2),
          nextStop: g.nextStopName,
          nextStopIndex: g.nextStopIndex,
          nextStopDistance: Number.isFinite(g.nextStopDistance) ? Math.round(g.nextStopDistance) : -1,
          served: g.stopsServed,
          missed: g.stopsMissed,
          total: g.stopsTotal,
          offRoute: g.offRoute,
          road: g.roadName,
          level: g.roadLevel,
          limit: g.speedLimit,
          signal: g.signal ? `${g.signal.state}@${Math.round(g.signal.distance)}` : null,
          collisions: g.collisions,
          load: g.load,
          capacity: g.capacity,
          dwell: g.dwell
            ? { stop: g.dwell.stop, off: g.dwell.alighting, offTotal: g.dwell.alightTotal, on: g.dwell.boarding, onTotal: g.dwell.boardTotal, full: g.dwell.full, done: g.dwell.done, doors: g.dwell.doors, kneelFor: g.dwell.kneelFor }
            : null,
          carried: g.passengersCarried,
          leftBehind: g.passengersLeft,
          delta: Math.round(g.scheduleDelta),
          finished: g.finished,
          problems: auto!.problems.length,
          ai: traffic.count,
          events: g.events.slice(-3).map((e) => `${e.kind}: ${e.text}`),
        };
      },
      /** AI vehicles within `r` metres of the bus (for attributing blocked spells). */
      traffic(r = 60) {
        const p = physics.pose;
        const near = (x: number, y: number) => Math.hypot(x - p.x, y - p.y) < r;
        const buses = traffic
          .markers()
          .filter((m) => near(m.x, m.y))
          .map((m) => ({ x: +m.x.toFixed(1), y: +m.y.toFixed(1), heading: Math.round((m.heading * 180) / Math.PI), length: m.length }));
        const g = traffic.cars.grid;
        const cars: { id: number; x: number; y: number; z: number; v: number }[] = [];
        for (let i = 0; i < g.count; i++) if (near(g.px[i], g.py[i])) cars.push({ id: g.pid[i], x: +g.px[i].toFixed(1), y: +g.py[i].toFixed(1), z: +g.pz[i].toFixed(1), v: +g.pv[i].toFixed(1) });
        return { buses, cars };
      },
      report() {
        return { ...auto!.report(), summary: guide.state.summary, served: guide.state.stopsServed, missed: guide.state.stopsMissed, total: guide.state.stopsTotal, events: guide.state.events.map((e) => `${e.kind}: ${e.text}`) };
      },
    };
    Object.assign(window, { __film: api });
    tick(1 / 60, true);
    return;
  }

  const frame = () => {
    requestAnimationFrame(frame);
    tick(Math.min(0.05, clock.getDelta()), true);
  };
  frame();
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#fff;padding:20px">Failed to start: ${String(err)}</pre>`;
});
