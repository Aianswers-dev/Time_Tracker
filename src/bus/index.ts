// Brisbane buses: Volgren Optimus 12.5 m (Transport for Brisbane TransLink
// livery, Blue/Maroon CityGlider, City Loop, contract operators) and the
// 24.7 m bi-articulated Brisbane Metro. See spec.ts for the dimensions and
// how the articulated section numbers fit together.
//
// createBus({ detail: 'high' })  player bus, ~25 draw calls (rigid), ~40 (Metro)
// createBus({ detail: 'low' })   AI bus, shared resources, 2-4 visible meshes per section
// createCab(type)                driver's cab + saloon, ~9 draw calls; eye at
//                                (0.62, 2.2, 1.4 m behind the nose) in section 0's frame
import type { BusFactory, BusMesh, BusType, Cab, Route } from '../types';
import { specFor } from './spec';
import { createHighBus } from './high';
import { createLowBus } from './low';
import { createCab } from './cab';

export { specFor };

export const busFactory: BusFactory = {
  specFor,
  createBus(opts: { type: BusType; route?: Route; detail: 'high' | 'low' }): BusMesh {
    const spec = specFor(opts.type);
    const bus = opts.detail === 'high' ? createHighBus(spec, opts.route) : createLowBus(spec, opts.route);
    if (opts.route && opts.detail === 'high') bus.setDestination({ route: opts.route.id, headsign: opts.route.headsign });
    return bus;
  },
  createCab(type: BusType): Cab {
    return createCab(type);
  },
};
