// STUB — replaced by the bus subsystem. Keep the exported `busFactory`.
import * as THREE from 'three';
import type { BusFactory, BusMesh, BusSpec, BusType, Cab } from '../types';
import { headingToRotY, toWorld } from '../data/coords';

function specFor(type: BusType): BusSpec {
  if (type === 'metro') {
    return {
      type, width: 2.55, height: 3.4, wheelbase: 5.9, frontOverhang: 2.7, maxSteer: 0.7, mass: 30000,
      sections: [
        { length: 9.6, axleFromFront: 8.6, hitchFromFront: 0, rearHitchFromFront: 9.6 },
        { length: 7.5, axleFromFront: 6.4, hitchFromFront: 0, rearHitchFromFront: 7.5 },
        { length: 7.6, axleFromFront: 5.0, hitchFromFront: 0, rearHitchFromFront: 7.6 },
      ],
    };
  }
  return {
    type, width: 2.5, height: 3.2, wheelbase: 6.1, frontOverhang: 2.75, maxSteer: 0.72, mass: 13000,
    sections: [{ length: 12.5, axleFromFront: 8.85, hitchFromFront: 0, rearHitchFromFront: 12.5 }],
  };
}

export const busFactory: BusFactory = {
  specFor,
  createBus({ type }): BusMesh {
    const spec = specFor(type);
    const sections = spec.sections.map((s) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(spec.width, spec.height, s.length),
        new THREE.MeshLambertMaterial({ color: 0xf4f4f4 }),
      );
      body.position.set(0, spec.height / 2 + 0.3, -(s.length / 2 - (s.length - s.axleFromFront)));
      g.add(body);
      return g;
    });
    return {
      spec,
      sections,
      setPose(pose) {
        pose.sections.forEach((p, i) => {
          const g = sections[i];
          if (!g) return;
          toWorld(p.x, p.y, 0, g.position);
          g.rotation.y = headingToRotY(p.heading);
        });
      },
      setLights() {},
      setDoors() {},
      setDestination() {},
      setInteriorView(inside) {
        sections[0].children[0].visible = !inside;
      },
      dispose() {},
    };
  },
  createCab(type): Cab {
    const spec = specFor(type);
    const s = spec.sections[0];
    const group = new THREE.Group();
    return { group, eye: new THREE.Vector3(0.6, 2.3, -s.axleFromFront + 0.8), update() {} };
  },
};
