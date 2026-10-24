// Passengers: how many get off and on at each stop, and the dwell that moves
// them through the doors. No people in the scene, just numbers: a seeded
// gravity model per stop (how many routes serve it, busway stations and the
// CBD hubs, time of day with commuters into the city in the morning and home
// in the evening, how far people ride) and per-passenger door times per bus
// type. The RouteGuide owns one and calls it every frame.
import type { BusType, MapData, Route } from '../types';
import { isStationStop, stopDisplayName, stopUsage } from './routeMeta';
import { clamp, hashString, rng } from './util';

/** Passengers a bus carries, seated plus standing. */
export const BUS_CAPACITY: Record<BusType, number> = { rigid: 65, glider: 70, metro: 150 };

interface DoorTimes {
  /** Mean seconds per passenger getting off (all doors together). */
  alight: number;
  /** Mean seconds per passenger getting on. */
  board: number;
  /** Demand relative to a standard bus (bigger, more frequent vehicles carry more per trip). */
  demand: number;
  /** Can ask the driver to kneel (Metro is level boarding). */
  kneel: boolean;
}

const DOORS: Record<BusType, DoorTimes> = {
  // Front door with a go card tap-on; off through the front and centre doors.
  rigid: { alight: 0.9, board: 2.0, demand: 1, kneel: true },
  // CityGlider is go card only, so boarding is a little quicker.
  glider: { alight: 0.85, board: 1.7, demand: 1.3, kneel: true },
  // Brisbane Metro: all-door boarding, tap on at the platform or the door.
  metro: { alight: 0.3, board: 0.38, demand: 2.6, kneel: false },
};

/** Doors fully open to the first passenger moving. */
const START_DELAY = 0.8;
/** Passenger time at a stop is squeezed to fit this (s). */
const DWELL_CAP = 40;
/**
 * Passenger time per stop the timetable already allows for (s). Anything
 * beyond it (a big crowd) is excused from the schedule delta, so a driver is
 * not marked late for waiting while people board, and gains nothing on the
 * timetable by closing the doors on them.
 */
const ALLOWANCE = 12;
/** How long a passenger with a pram waits for the kneel before struggling on anyway (s). */
const PRAM_WAIT = 6;
/** Busiest interchanges on the map. */
const HUB = /^(King George Square|Queen Street|Cultural Centre|Roma Street)/i;
const NEEDS = ['with a pram', 'with a pram', 'with a pram', 'in a wheelchair', 'with a walking frame'];

/** Boardings relative to midday, through the day (peaks 7–9 and 16–18:30, quiet at night). */
const DAY: [number, number][] = [
  [0, 0.16], [5, 0.16], [6, 0.55], [7, 1.5], [8, 1.75], [9, 1.35], [10, 0.95], [12, 1], [14.5, 0.95],
  [15.5, 1.2], [16.5, 1.65], [17.5, 1.75], [18.5, 1.4], [19.5, 0.8], [22, 0.42], [23, 0.22], [24, 0.16],
];

export function timeOfDayFactor(hours: number): number {
  const h = ((hours % 24) + 24) % 24;
  for (let i = 1; i < DAY.length; i++) {
    const [h1, f1] = DAY[i];
    if (h <= h1) {
      const [h0, f0] = DAY[i - 1];
      return f0 + ((f1 - f0) * (h - h0)) / Math.max(1e-6, h1 - h0);
    }
  }
  return DAY[0][1];
}

export type DoorPhase = 'opening' | 'open' | 'closing';

/** What the HUD and the autopilot see of the stop being served. */
export interface DwellState {
  /** Route stop index being served. */
  stop: number;
  stopName: string;
  /** Passengers still to get off (counts down to 0). */
  alighting: number;
  alightTotal: number;
  /** Passengers on so far (counts up to boardTotal). */
  boarding: number;
  boardTotal: number;
  /** Waiting passengers who did not fit (bus full). */
  full: number;
  /** Everyone who could has got off and on: close the doors. */
  done: boolean;
  /** Passengers are moving (doors fully open, bus held at the stop). */
  flowing: boolean;
  /** Door phase: passengers only move once they are fully open; 'closing' = the driver pressed close. */
  doors: DoorPhase;
  /** "with a pram" etc. while a passenger waits for the bus to kneel, else ''. */
  kneelFor: string;
  /** End of the line: everyone off, nobody on. */
  last: boolean;
}

/** Relative chance of riding `d` metres: hardly anyone for one short hop, fading past ~4 km. */
function tripLength(d: number): number {
  return d <= 0 ? 0 : (d / (d + 600)) * Math.exp(-d / 4000);
}

interface Flows {
  /** Getting off here (per boarding stop in Passengers.quota). */
  alight: number;
  board: number;
  /** Index of the boarder who needs the kneel, or -1. */
  needs: number;
  need: string;
  r: () => number;
}

function poisson(mean: number, r: () => number): number {
  if (mean <= 0) return 0;
  if (mean > 30) {
    // Normal approximation (Box–Muller).
    const g = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
    return Math.max(0, Math.round(mean + Math.sqrt(mean) * g));
  }
  const L = Math.exp(-mean);
  let k = 0;
  let p = r();
  while (p > L && k < 200) {
    k++;
    p *= r();
  }
  return k;
}

export class Passengers {
  readonly capacity: number;
  /** On board now. */
  load = 0;
  /** Boardings over the shift. */
  carried = 0;
  /** Left behind (or carried past their stop) by closing the doors early. */
  left = 0;
  /** Could not get on because the bus was full. */
  full = 0;
  /** Passenger time beyond the timetable's allowance over the shift (s), excused from the schedule. */
  excused = 0;
  /** The dwell being shown, or null (also null once the doors have closed). */
  view: DwellState | null = null;

  private readonly doors: DoorTimes;
  /** How busy each route stop is (riders on, and riders heading there), before the time of day. */
  private readonly weight: Float32Array;
  /** 1 in the CBD, 0 in the suburbs, for the commuter tilt. */
  private readonly cbd: Float32Array;
  /** Route distance of each stop. */
  private readonly sAt: Float32Array;
  /** 0.1..1: how much of where people go is still ahead (few board for the last stop or two). */
  private readonly ahead: Float32Array;
  /** Riders on board by the route stop they got on at. */
  private readonly cohort: Int32Array;
  /** Of each cohort, how many get off at the stop being served. */
  private readonly quota: Int32Array;
  private readonly seed: number;
  private readonly dwell: DwellState = { stop: -1, stopName: '', alighting: 0, alightTotal: 0, boarding: 0, boardTotal: 0, full: 0, done: false, flowing: false, doors: 'opening', kneelFor: '', last: false };
  private active = false;
  private closed = false;
  /** Counted as left behind when the doors shut (undone if they reopen). */
  private closedOn = 0;
  private wait = 0;
  private scale = 1;
  private needs = -1;
  private need = '';
  private hold = 0;
  /** Seconds passengers have been moving at this stop. */
  private flowT = 0;
  /** Who is in the doorway: getting off, getting on, or nobody yet. */
  private cur: '' | 'off' | 'on' = '';
  private r: () => number = Math.random;

  constructor(
    readonly data: MapData,
    readonly route: Route,
    readonly type: BusType,
    private readonly emit: (kind: 'leftbehind' | 'full', text: string) => void,
  ) {
    this.capacity = BUS_CAPACITY[type];
    this.doors = DOORS[type];
    const usage = stopUsage(data);
    const n = route.stops.length;
    this.weight = new Float32Array(n);
    this.cbd = new Float32Array(n);
    this.sAt = new Float32Array(n);
    this.ahead = new Float32Array(n);
    this.cohort = new Int32Array(n);
    this.quota = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const st = data.stops[route.stops[i].stop];
      // Weekly trips through the stop over all routes, on a log scale: ~60 a week is a quiet suburban stop, 8000+ a busway station.
      const heat = clamp(Math.log(Math.max(1, usage[route.stops[i].stop]) / 60) / Math.log(8000 / 60), 0, 1);
      const r = Math.hypot(st.x, st.y);
      let w = 0.35 + 2.2 * heat ** 1.5;
      if (HUB.test(st.name)) w *= 1.9;
      else if (isStationStop(st.name)) w *= 1.45;
      else if (r < 1100) w *= 1.35;
      this.weight[i] = w;
      this.cbd[i] = clamp((2600 - r) / 1400, 0, 1);
      this.sAt[i] = route.stops[i].s;
    }
    let most = 1e-6;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = i + 1; j < n; j++) m += this.weight[j] * tripLength(this.sAt[j] - this.sAt[i]);
      this.ahead[i] = m;
      most = Math.max(most, m);
    }
    for (let i = 0; i < n; i++) this.ahead[i] = clamp(this.ahead[i] / (0.5 * most), 0.1, 1);
    this.seed = hashString(`${route.id}|${route.dir}|${route.headsign}`);
  }

  get busy(): boolean {
    return this.active && !this.closed && !this.dwell.done;
  }

  /** Route stop index of the dwell in progress (doors may be shut), or -1. */
  get stopIndex(): number {
    return this.active ? this.dwell.stop : -1;
  }

  /**
   * Who gets off and on at route stop i (deterministic per stop and hour, given
   * who is aboard). Fills `quota` with who gets off, by the stop they got on at.
   */
  private plan(i: number, hours: number): Flows {
    const n = this.route.stops.length;
    const h = ((hours % 24) + 24) % 24;
    const st = this.data.stops[this.route.stops[i].stop];
    const r = rng(this.seed ^ hashString(`${i}|${st.code}`) ^ Math.imul(Math.floor(h) + 1, 0x9e3779b1));
    // Commuters: into the city in the morning peak, home in the evening.
    const am = clamp(Math.min(h - 6, 10 - h), 0, 1);
    const pm = clamp(Math.min(h - 15, 19.5 - h), 0, 1);
    const dest = (k: number) => this.weight[k] * (1 + 0.9 * am * this.cbd[k] + 0.9 * pm * (1 - this.cbd[k]));
    const last = i === n - 1;
    const q = this.quota;
    q.fill(0);
    let alight = 0;
    for (let c = 0; c < i; c++) {
      const m = this.cohort[c];
      if (!m) continue;
      let k = m;
      if (!last) {
        // Each rider from c gets off here with this stop's share of where riders from c still go.
        const here = dest(i) * tripLength(this.sAt[i] - this.sAt[c]);
        let all = here;
        for (let j = i + 1; j < n; j++) all += dest(j) * tripLength(this.sAt[j] - this.sAt[c]);
        const p = all > 0 ? here / all : 1;
        k = 0;
        for (let x = 0; x < m; x++) if (r() < p) k++;
      }
      q[c] = k;
      alight += k;
    }
    let board = 0;
    if (!last) {
      const c = this.cbd[i];
      const tilt = 1 + (0.35 * am - 0.25 * pm) * (1 - c) + (0.35 * pm - 0.25 * am) * c;
      board = poisson(1.9 * this.weight[i] * timeOfDayFactor(h) * this.doors.demand * this.ahead[i] * tilt, r);
      // Somebody rang the bell or hailed the bus: a stop is never empty.
      if (alight + board === 0) {
        const c0 = this.cohort.findIndex((m, j) => m > 0 && j < i);
        if (c0 >= 0) {
          q[c0] = 1;
          alight = 1;
        } else board = 1;
      }
    }
    let needs = -1;
    let need = '';
    const day = h > 7 && h < 19;
    if (board > 0 && this.doors.kneel && r() < (day ? 0.13 : 0.05)) {
      needs = 0;
      need = NEEDS[Math.floor(r() * NEEDS.length)];
    }
    return { alight, board, needs, need, r };
  }

  /** Riders on board when the shift starts at route stop `first` (from the stops before it). */
  startAt(first: number, hours: number): void {
    this.cohort.fill(0);
    this.load = 0;
    for (let i = 0; i < first && i < this.route.stops.length - 1; i++) {
      const f = this.plan(i, hours);
      for (let c = 0; c < i; c++) this.cohort[c] -= this.quota[c];
      this.load -= f.alight;
      const b = Math.min(f.board, this.capacity - this.load);
      this.cohort[i] += b;
      this.load += b;
    }
    this.quota.fill(0);
  }

  /** Doors opened at route stop i: start the dwell. */
  start(i: number, hours: number): void {
    this.depart();
    const f = this.plan(i, hours);
    const d = this.dwell;
    d.stop = i;
    d.stopName = stopDisplayName(this.data.stops[this.route.stops[i].stop].name);
    d.alightTotal = f.alight;
    d.alighting = f.alight;
    d.boardTotal = f.board;
    d.boarding = 0;
    d.full = 0;
    d.done = f.alight + f.board === 0;
    d.flowing = false;
    d.doors = 'opening';
    d.kneelFor = f.need;
    d.last = i === this.route.stops.length - 1;
    this.needs = f.needs;
    this.need = f.need;
    this.hold = 0;
    this.flowT = 0;
    this.r = f.r;
    // Squeeze a big crowd into the cap (people hurry when the bus is packed).
    const T = f.alight * this.doors.alight + f.board * this.doors.board + (f.needs >= 0 ? 2.5 : 0);
    this.scale = T > DWELL_CAP - START_DELAY ? (DWELL_CAP - START_DELAY) / T : 1;
    this.wait = START_DELAY;
    this.cur = '';
    this.active = true;
    this.closed = false;
    this.closedOn = 0;
    this.view = d;
  }

  /** Pulled away from the departure stop without opening the doors. */
  leaveAll(i: number, hours: number): void {
    const f = this.plan(i, hours);
    this.quota.fill(0);
    if (f.board <= 0) return;
    this.left += f.board;
    this.emit('leftbehind', `Left ${f.board} passenger${f.board === 1 ? '' : 's'} at ${stopDisplayName(this.data.stops[this.route.stops[i].stop].name)}`);
  }

  /** The bus has left the stop: the dwell is over. */
  depart(): void {
    if (!this.active) return;
    if (!this.closed) this.shut();
    this.active = false;
    this.view = null;
  }

  private shut(): void {
    const d = this.dwell;
    this.closed = true;
    this.view = null;
    // Riders still to get off stay aboard (past their stop); those still waiting stay at the stop.
    const n = d.alighting + (d.done ? 0 : d.boardTotal - d.boarding);
    this.closedOn = n;
    if (n > 0) {
      this.left += n;
      this.emit('leftbehind', `Closed doors on ${n} passenger${n === 1 ? '' : 's'}`);
    }
  }

  /**
   * Advance the dwell. `doors`: their phase, or 'shut' once fully closed;
   * passengers move while they are 'open' and the bus is `stopped` at the stop.
   * `kneel` 0..1 from the controls. `onClock`: the shift clock is running (not
   * at the departure stop).
   */
  update(dt: number, doors: DoorPhase | 'shut', stopped: boolean, kneel: number, onClock = true): void {
    if (!this.active) return;
    const d = this.dwell;
    if (doors === 'shut') {
      if (!this.closed) this.shut();
      return;
    }
    if (this.closed) {
      // Reopened before pulling away: they get their chance after all.
      this.closed = false;
      this.left -= this.closedOn;
      this.closedOn = 0;
      this.view = d;
    }
    const knelt = kneel > 0.9;
    // Ask for the kneel until the passenger who needs it is aboard (the driver can see them waiting).
    d.kneelFor = this.needs >= d.boarding && !knelt && !d.done ? this.need : '';
    d.doors = doors;
    d.flowing = doors === 'open' && stopped && !d.done;
    if (!d.flowing) return;
    this.flowT += dt;
    if (this.flowT > ALLOWANCE && onClock) this.excused += dt;
    if (this.hold > 0) {
      // Waiting at the door for the kneel; after a while they struggle up the step anyway.
      this.hold += dt;
      if (!knelt && this.hold < PRAM_WAIT) return;
      this.hold = 0;
      this.cur = 'on';
      this.wait = (knelt ? 2.2 : 4) * this.scale;
    }
    this.wait -= dt * (knelt && this.cur === 'on' ? 1.12 : 1);
    for (let guard = 0; this.wait <= 0 && guard < 8; guard++) {
      // The passenger in the doorway is through.
      if (this.cur === 'off') {
        d.alighting--;
        this.load = Math.max(0, this.load - 1);
        const c = this.quota.findIndex((k) => k > 0);
        if (c >= 0) {
          this.quota[c]--;
          this.cohort[c]--;
        }
      } else if (this.cur === 'on') {
        d.boarding++;
        this.load++;
        this.carried++;
        this.cohort[d.stop]++;
      }
      this.cur = '';
      if (!this.next(knelt)) break;
    }
    if (d.done) d.flowing = false;
  }

  /** Send the next passenger through the door; false when nobody moves (done, or waiting for the kneel). */
  private next(knelt: boolean): boolean {
    const d = this.dwell;
    const j = 0.75 + 0.5 * this.r();
    if (d.alighting > 0) {
      this.cur = 'off';
      this.wait += this.doors.alight * this.scale * j;
      return true;
    }
    if (d.boarding >= d.boardTotal) {
      d.done = true;
      return false;
    }
    if (this.load >= this.capacity) {
      d.full = d.boardTotal - d.boarding;
      this.full += d.full;
      d.done = true;
      this.emit('full', `Bus full — ${d.full} left at the stop`);
      return false;
    }
    if (d.boarding === this.needs && !knelt) {
      this.hold = 1e-6;
      this.wait = 0;
      return false;
    }
    this.cur = 'on';
    this.wait += (d.boarding === this.needs ? 2.2 : this.doors.board * j) * this.scale;
    return true;
  }
}
