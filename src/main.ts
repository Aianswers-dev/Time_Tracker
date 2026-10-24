import * as THREE from 'three';
import './style.css';
import { loadMapData } from './data/load';
import { headingDir, pointAlong } from './data/coords';
import { buildWorld } from './world';
import { busFactory } from './bus';
import { BusAudio, BusControls, BusPhysics, CameraRig, InputManager, buildCollider } from './sim';
import { Hud, RouteGuide, Traffic, busTypeForRoute, showMenu } from './game';

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
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
  const guide = new RouteGuide(scene, data, route, { busLength: bus.spec.sections.reduce((a, s) => a + s.length, 0) });
  const hud = new Hud(document.body, data, { traffic, guide });
  // Player collides with buildings and with the AI buses and cars.
  const playerCollider = traffic.wrapCollider(collider);

  // startPose gives the FRONT of the bus; physics tracks the rear axle.
  const start = guide.startPose();
  const startS = Number(params.get('s') ?? 0);
  if (startS > 0) Object.assign(start, pointAlong(route.pts, route.cum, startS));
  const rearOffset = bus.spec.sections[0].axleFromFront;
  const [fx, fy] = headingDir(start.heading);
  physics.reset(start.x - fx * rearOffset, start.y - fy * rearOffset, start.heading);
  controls.lights.headlights = choice.hours < 6.5 || choice.hours > 18;

  for (let i = 0; i < Number(params.get('cam') === 'chase' ? 1 : params.get('cam') === 'top' ? 2 : 0); i++) rig.cycle();
  let hours = choice.hours;
  let paused = false;
  let fps = 60;
  const clock = new THREE.Clock();
  let simTime = 0;
  let splashed = false;
  let dingedStop = -1;

  const frame = () => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, clock.getDelta());
    fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
    const inp = input.poll(dt);
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
    if (paused) {
      renderer.render(scene, camera);
      return;
    }
    simTime += dt;
    hours = (hours + dt / 3600) % 24;

    controls.update(dt, inp, physics.pose);
    const hit = physics.update(dt, inp, controls, playerCollider);
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
    const g = guide.update(dt, frontX, frontY, controls.doorsOpen, pose.speed, pose.heading, hours);
    // Stop-request bell once per stop as it comes within 250 m.
    if (!g.finished && g.nextStopDistance < 250 && g.nextStopIndex !== dingedStop) {
      dingedStop = g.nextStopIndex;
      audio.ding();
    }

    cab.update({
      speedKmh: Math.abs(pose.speed) * 3.6,
      rpm: physics.rpm,
      steeringWheel: (pose.steer / bus.spec.maxSteer) * Math.PI * 1.75,
      lights: controls.lights,
      doorsOpen: controls.doorsOpen,
      stopRequested: g.nextStopDistance < 250 && !g.finished,
      timeSeconds: simTime,
    });
    rig.update(dt, bus, cab, pose, inp);
    audio.update({ rpm: physics.rpm, throttle: inp.throttle, speed: pose.speed, brake: inp.brake });
    audio.horn(inp.held.has('horn'));

    traffic.update(dt, simTime, pose, camera, hours);
    world.update(dt, camera, hours);
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
  frame();
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="color:#fff;padding:20px">Failed to start: ${String(err)}</pre>`;
});
