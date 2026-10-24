/** Brisbane River, creeks and the bay: an animated reflective surface at the water level. */
import * as THREE from 'three';
import type { Ctx } from './ctx';
import { FlatGeo, triangulate, waterPolys } from './ground';
import { patch } from './shaders';

export function buildWater(ctx: Ctx): void {
  const g = new FlatGeo();
  const level = ctx.data.terrain.waterLevel;
  for (const w of waterPolys(ctx)) {
    if (w.outer.length < 6) continue;
    const { coords, tris } = triangulate(w.outer, w.holes);
    g.add(coords, tris, level);
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0x3e4733, roughness: 0.1, metalness: 0.0, envMapIntensity: 1.0 });
  patch(mat, {
    key: 'water',
    uniforms: { uWaterN: { value: ctx.tex.waterNormal } },
    vertexPars: 'varying vec3 vGPos;',
    vertex: [['#include <begin_vertex>', '#include <begin_vertex>\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;']],
    fragmentPars: 'uniform sampler2D uWaterN;\nuniform float uTime;\nvarying vec3 vGPos;',
    fragment: [
      [
        '#include <normal_fragment_maps>',
        `{
          vec2 wp = vec2(vGPos.x, -vGPos.z);
          vec3 n1 = texture2D(uWaterN, wp / 41.0 + vec2(uTime * 0.011, uTime * 0.004)).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(uWaterN, wp / 13.0 + vec2(-uTime * 0.017, uTime * 0.021)).xyz * 2.0 - 1.0;
          vec3 n3 = texture2D(uWaterN, wp / 3.7 + vec2(uTime * 0.05, -uTime * 0.03)).xyz * 2.0 - 1.0;
          float fade = clamp(vWDist / 600.0, 0.0, 1.0);
          vec2 t = (n1.xy * 0.55 + n2.xy * 0.35 + n3.xy * 0.25 * (1.0 - fade)) * mix(0.55, 0.2, fade);
          vec3 wn = normalize(vec3(t.x, 1.0, -t.y));
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`,
      ],
      [
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec2 wp = vec2(vGPos.x, -vGPos.z);
          diffuseColor.rgb *= 0.85 + 0.3 * texture2D(uWaterN, wp / 400.0).b;
        }`,
      ],
    ],
  });
  const mesh = new THREE.Mesh(g.build(), mat);
  mesh.name = 'water';
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  ctx.root.add(mesh);
}
