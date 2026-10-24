// Dev harness for the bus models: /src/bus/preview.html?type=metro&angle=30
// Params: type, route, detail (high|low), angle, dist, h, tx (look-at offset
// along the bus), view=cab (look, pitch), lights=head,brake,left,right,hazard,
// reverse, doors (0..1), night=1, steer, bend (deg), fleet=1, many=N,
// speed (km/h), rpm, stop=1, t (seconds), spin=1, inside=1.
import * as THREE from 'three';
import type { BusLights, BusMesh, BusPose, BusType, Cab, Route } from '../types';
import { busFactory } from './index';
import { headingDir } from '../data/coords';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const type = (q.get('type') ?? 'rigid') as BusType;
const night = q.get('night') === '1';

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(night ? 0x0b1020 : 0x9ec9ef);
scene.add(new THREE.HemisphereLight(0xffffff, 0x445533, night ? 0.15 : 1.2));
const sun = new THREE.DirectionalLight(0xffffff, night ? 0.05 : 1.6);
sun.position.set(-30, 60, 25);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x55585c }));
if (q.get('bare') !== '1') scene.add(ground);
// lane markings + kerb for scale
const marks = new THREE.Group();
for (let z = -100; z < 100; z += 6) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 3).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xeeeeee }));
  m.position.set(3.2, 0.01, z);
  marks.add(m);
}
const kerb = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.15, 200), new THREE.MeshLambertMaterial({ color: 0xb8b4aa }));
kerb.position.set(-2.4, 0.075, 0);
marks.add(kerb);
const footpath = new THREE.Mesh(new THREE.BoxGeometry(4, 0.15, 200), new THREE.MeshLambertMaterial({ color: 0x9c978c }));
footpath.position.set(-4.5, 0.075, 0);
marks.add(footpath);
if (q.get('bare') !== '1') scene.add(marks);

const ROUTES: Record<string, [string, string]> = {
  '60': ['West End Ferry', 'BT'],
  '61': ['Coorparoo, Old Cleveland Rd', 'BT'],
  '40': ['City Loop, Alice St', 'BT'],
  '412': ['St Lucia South', 'BT'],
  '385': ['The Gap park ’n’ ride', 'BT'],
  '196': ['New Farm, Mountford Rd', 'BT'],
  M1: ['Eight Mile Plains station', 'MET'],
  M2: ['UQ Lakes station', 'MET'],
  '555': ['Loganholme station', 'LCBS'],
};

function fakeRoute(id: string): Route {
  const [headsign, operator] = ROUTES[id] ?? ['City', 'BT'];
  return { id, name: id, dir: 0, headsign, color: '#000', textColor: '#fff', operator, trips: 1, pts: new Float32Array(4), cum: new Float32Array(2), z: new Float32Array(2), length: 1, stops: [] };
}

function poseFor(bus: BusMesh, x: number, y: number, heading: number, bendDeg: number, steer: number): BusPose {
  const spec = bus.spec;
  const sections: { x: number; y: number; heading: number }[] = [{ x, y, heading }];
  for (let i = 1; i < spec.sections.length; i++) {
    const prev = sections[i - 1];
    const sp = spec.sections[i - 1];
    const sc = spec.sections[i];
    const [fx, fy] = headingDir(prev.heading);
    const back = sp.rearHitchFromFront - sp.axleFromFront;
    const px = prev.x - fx * back, py = prev.y - fy * back;
    const h = prev.heading - (bendDeg * Math.PI) / 180;
    const [gx, gy] = headingDir(h);
    const d = sc.axleFromFront - sc.hitchFromFront;
    sections.push({ x: px - gx * d, y: py - gy * d, heading: h });
  }
  return { x, y, heading, speed: 0, steer, wheelSpin: num('spinAngle', 0.4), sections, roll: num('roll', 0), pitch: num('pitch', 0) };
}

const lightsList = (q.get('lights') ?? (night ? 'head' : '')).split(',');
const lights: BusLights = {
  headlights: lightsList.includes('head'),
  brake: lightsList.includes('brake'),
  reverse: lightsList.includes('reverse'),
  indicatorLeft: lightsList.includes('left'),
  indicatorRight: lightsList.includes('right'),
  hazards: lightsList.includes('hazard'),
};
const t = num('t', 0.1);

const buses: { bus: BusMesh; pose: BusPose }[] = [];
let cab: Cab | null = null;

function addBus(bt: BusType, routeId: string | null, detail: 'high' | 'low', x: number, y: number, heading: number): BusMesh {
  const route = routeId ? fakeRoute(routeId) : undefined;
  const bus = busFactory.createBus({ type: bt, route, detail });
  if (route) bus.setDestination({ route: route.id, headsign: route.headsign });
  for (const s of bus.sections) scene.add(s);
  const pose = poseFor(bus, x, y, heading, num('bend', 0), num('steer', 0));
  bus.setPose(pose);
  bus.setLights(lights, t);
  bus.setDoors(num('doors', 0));
  buses.push({ bus, pose });
  return bus;
}

const camera = new THREE.PerspectiveCamera(num('fov', 70), innerWidth / innerHeight, 0.05, 3000);
const detail = (q.get('detail') ?? 'high') as 'high' | 'low';

if (q.get('fleet') === '1') {
  const list: [BusType, string][] = [
    ['rigid', '412'],
    ['glider', '60'],
    ['glider', '61'],
    ['rigid', '40'],
    ['rigid', '555'],
    ['metro', 'M2'],
  ];
  list.forEach(([bt, r], i) => addBus(bt, r, detail, (i - 2.5) * 4.2, 0, 0));
} else if (q.has('many')) {
  const n = num('many', 60);
  const kinds: [BusType, string][] = [['rigid', '412'], ['rigid', '196'], ['glider', '60'], ['glider', '61'], ['metro', 'M1'], ['rigid', '555'], ['rigid', '40']];
  for (let i = 0; i < n; i++) {
    const [bt, r] = kinds[i % kinds.length];
    addBus(bt, r, 'low', (i % 10) * 4.5 - 20, -Math.floor(i / 10) * 30, 0);
  }
} else {
  const bus = addBus(type, q.get('route') ?? (type === 'glider' ? '61' : type === 'metro' ? 'M2' : '412'), detail, 0, 0, 0);
  if (q.get('view') === 'cab' || q.get('cab') === '1') {
    cab = busFactory.createCab(type);
    bus.sections[0].add(cab.group);
  }
  if (q.get('view') === 'cab') bus.setInteriorView(true);
}

const info = document.getElementById('info');
const target = new THREE.Vector3();
function place(time: number): void {
  if (q.get('view') === 'cab' && cab) {
    const g = buses[0].bus.sections[0];
    g.updateMatrixWorld();
    const e = cab.eye.clone();
    if (q.has('ez')) e.set(num('ex', e.x), num('ey', e.y), num('ez', e.z));
    camera.position.copy(e).applyMatrix4(g.matrixWorld);
    camera.rotation.set((num('cpitch', 0) * Math.PI) / 180, (num('look', 0) * Math.PI) / 180, 0, 'YXZ');
    return;
  }
  let ang = (num('angle', 35) * Math.PI) / 180;
  if (q.get('spin') === '1') ang += time * 0.0003;
  const len = q.get('fleet') === '1' ? 34 : type === 'metro' ? 26 : 15;
  const dist = num('dist', len);
  // angle 0 = looking at the front, 90 = kerb (left) side, 180 = rear
  // default look-at: centre of all bus sections (+ tx metres forward)
  const box = new THREE.Box3();
  for (const b of buses) for (const s of b.bus.sections) box.expandByObject(s);
  box.getCenter(target);
  target.y = num('ty', 1.6);
  target.z -= num('tx', 0);
  target.x += num('tz', 0);
  camera.position.set(target.x - Math.sin(ang) * dist, num('h', 3.5), target.z - Math.cos(ang) * dist);
  if (q.has('many')) {
    camera.position.set(-8, 14, 30);
    target.set(0, 0, -60);
  }
  camera.lookAt(target);
}

function frame(time: number): void {
  requestAnimationFrame(frame);
  place(time);
  const tt = t + time / 1000;
  for (const b of buses) {
    b.bus.setLights(lights, q.has('t') ? t : tt);
    b.bus.setInteriorView(q.get('view') === 'cab'); // like the game's CameraRig, every frame
  }
  cab?.update({
    speedKmh: num('speed', 38),
    rpm: num('rpm', 1450),
    steeringWheel: num('wheel', 0.6),
    lights,
    doorsOpen: num('doors', 0) > 0.02,
    stopRequested: q.get('stop') === '1',
    timeSeconds: q.has('t') ? t : tt,
  });
  renderer.render(scene, camera);
  if (info) info.textContent = `calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}`;
}
(window as unknown as { __scene: THREE.Scene; __THREE: typeof THREE; __camera: THREE.Camera }).__scene = scene;
(window as unknown as { __THREE: typeof THREE }).__THREE = THREE;
(window as unknown as { __camera: THREE.Camera }).__camera = camera;
requestAnimationFrame(frame);
setTimeout(() => console.log(`calls=${renderer.info.render.calls} tris=${renderer.info.render.triangles} geos=${renderer.info.memory.geometries} tex=${renderer.info.memory.textures}`), 2500);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
