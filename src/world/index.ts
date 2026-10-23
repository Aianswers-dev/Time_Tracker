// STUB — replaced by the world subsystem. Keep the exported signature.
import * as THREE from 'three';
import type { MapData, WorldHandle } from '../types';

export async function buildWorld(
  scene: THREE.Scene,
  _renderer: THREE.WebGLRenderer,
  data: MapData,
  onProgress: (fraction: number, label: string) => void,
): Promise<WorldHandle> {
  onProgress(0, 'Building city…');
  scene.background = new THREE.Color(0x9ec9ef);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445533, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(300, 600, 200);
  scene.add(sun);
  const [x0, y0, x1, y1] = data.bounds;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(x1 - x0, y1 - y0).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x8a9a70 }),
  );
  ground.position.set((x0 + x1) / 2, -0.05, -(y0 + y1) / 2);
  scene.add(ground);
  const pos: number[] = [];
  for (const r of data.roads) {
    for (let i = 0; i + 3 < r.pts.length; i += 2) pos.push(r.pts[i], 0.05, -r.pts[i + 1], r.pts[i + 2], 0.05, -r.pts[i + 3]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x333333 })));
  onProgress(1, 'City ready');
  return { update() {} };
}
