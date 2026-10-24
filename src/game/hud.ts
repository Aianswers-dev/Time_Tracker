// DOM HUD: route card, turn hints, next stop console, speed cluster, minimap,
// full-screen map, toasts and the end-of-route summary. Writes to the DOM
// only when a displayed value changes.
import './hud.css';
import type { BusLights, BusPose, MapData, Route } from '../types';
import type { GuideState, RouteSummary } from './guide';
import type { DwellState } from './passengers';
import { StopStatus } from './guide';
import { Minimap, type MapMarker } from './minimap';
import { FullMap } from './fullmap';
import {
  ICON_ALIGHT,
  ICON_BOARD,
  ICON_CLOCK,
  ICON_DOORS,
  ICON_HAZARD,
  ICON_HEADLIGHT,
  ICON_INDICATOR_L,
  ICON_INDICATOR_R,
  ICON_MAP,
  ICON_PARK,
  ICON_PAX,
  ICON_RIBBON,
  turnArrow,
} from './icons';
import { session } from './session';
import { FlagSlot, TextSlot, brighten, el, escapeHtml, fmtClock, fmtDelta, fmtDistance, fmtDuration } from './util';

export interface HudFrame {
  route: Route;
  pose: BusPose;
  speedKmh: number;
  rpm: number;
  gear: string;
  lights: BusLights;
  doorsOpen: boolean;
  guide: GuideState;
  hours: number;
  cameraMode: string;
  fps: number;
  /** Optional extras (wire them in when available). */
  parkBrake?: boolean;
  /** Other vehicles for the maps; defaults to opts.traffic.markers(). */
  vehicles?: readonly MapMarker[];
  paused?: boolean;
}

export interface HudOptions {
  /** Anything with markers() (the Traffic class) for buses on the maps. */
  traffic?: { markers(): readonly MapMarker[] };
  /** The RouteGuide, so the HUD's chevron button can toggle the ribbon. */
  guide?: { toggleRibbon(on?: boolean): void };
  showFps?: boolean;
}

type ToastKind = 'info' | 'good' | 'bad' | 'warn';

interface LiveToast {
  el: HTMLDivElement;
  key: string;
  n: number;
  timer: number;
  badge: HTMLElement | null;
}

/** A displayed value that only changes once a new value has held for `hold` seconds of sim time. */
class Steady<T> {
  private pend: T;
  private since = 0;
  private fresh = true;
  constructor(
    public shown: T,
    readonly hold: number,
  ) {
    this.pend = shown;
  }
  update(v: T, t: number): T {
    if (this.fresh) {
      this.fresh = false;
      this.shown = this.pend = v;
    }
    if (v === this.shown) {
      this.pend = v;
      return v;
    }
    if (v !== this.pend) {
      this.pend = v;
      this.since = t;
    }
    if (t - this.since >= this.hold) this.shown = v;
    return this.shown;
  }
}

/** OSM `ref`s used as a name when a way has none ('22;95', '5'): not a street name. */
const REF_ONLY = /^[A-Z]{0,2}\d+[A-Z]?(\s*[;,/]\s*[A-Z]{0,2}\d+[A-Z]?)*$/;
const TOAST_MS = 3200;

export class Hud {
  private root: HTMLDivElement;
  private mini: Minimap | null = null;
  private full: FullMap | null = null;
  private mapOpen = false;
  private lastRoute: Route | null = null;
  private lastEvent = 0;
  private summaryShown = false;
  private summaryTimer = -1;
  private departHours: number | null = null;
  private lastTime = performance.now();
  private miniAcc = 0;
  private fullAcc = 0;
  private lastFrame: HudFrame | null = null;
  private stopTicks: HTMLElement[] = [];
  private tickState: number[] = [];
  private nAngle = NaN;
  private lastProgress = -1;
  private turnKey = '';
  private offAngle = NaN;
  private gradeShown = false;
  private gradeText = '';
  private dwellKey = '';
  private dwellStop = -1;
  private loadKey = '';
  private readonly toasts: HTMLDivElement;
  private live: LiveToast[] = [];
  /** Sim time (s) from the frames' clock, for debouncing what the guide reports. */
  private simT = 0;
  private lastHours = NaN;
  private road = new Steady('', 1.5);
  private limit = new Steady(50, 1.2);
  private offStartT = -1e9;
  private lastOnToastT = -1e9;

  // Slots
  private s: Record<string, TextSlot> = {};
  private f: Record<string, FlagSlot> = {};
  private els: Record<string, HTMLElement> = {};

  constructor(
    host: HTMLElement,
    readonly data: MapData,
    readonly opts: HudOptions = {},
  ) {
    const root = el('div', 'bbh');
    this.root = root;
    root.innerHTML = `
      <div class="bbh-panel bbh-route">
        <span class="bbh-badge" data-e="badge"></span>
        <div style="min-width:0"><div class="bbh-to">Route to</div><div class="bbh-hs" data-t="hs"></div><div class="bbh-road"><span data-t="road"></span><span class="bbh-lvl" data-t="lvl"></span><span class="bbh-slope" data-e="slope"></span></div></div>
        <div class="bbh-progress" data-e="progress"><b data-e="bar"></b></div>
      </div>
      <div class="bbh-panel bbh-turn" data-e="turn"><div class="bbh-arrow" data-e="tarrow"></div><div class="bbh-ttext"><div class="bbh-dist" data-t="tdist"></div><div class="bbh-txt" data-t="ttext"></div></div></div>
      <div class="bbh-panel bbh-next" data-e="next">
        <div class="bbh-nhead"><span class="bbh-cap" data-t="ncap">Next stop</span><span class="bbh-stopno" data-t="nno"></span></div>
        <div class="bbh-nname" data-t="nname"></div>
        <div class="bbh-nrow"><span class="bbh-ndist" data-t="ndist"></span><span class="bbh-counts"><span class="ok">✓ <b data-t="served">0</b></span><span class="bad">✕ <b data-t="missed">0</b></span><span>of <b data-t="total">0</b></span></span></div>
        <div class="bbh-stopping" data-t="stopping">BUS STOPPING</div>
        <div class="bbh-sched"><span><span class="bbh-cap">Timetable</span> <span data-t="due"></span></span><span class="bbh-pill idle" data-e="pill"></span></div>
      </div>
      <div class="bbh-panel bbh-clock">${ICON_CLOCK}<span data-t="clock"></span><span class="bbh-shift" data-t="shift"></span><span class="bbh-load" data-e="load" title="Passengers on board / capacity">${ICON_PAX}<b data-t="load">0</b><small data-t="cap"></small></span></div>
      <div class="bbh-mini" data-e="mini" title="Tap to zoom"><div class="bbh-n" data-e="north">N</div><span class="bbh-zoom" data-t="zoom">600 m</span></div>
      <button class="bbh-ribbon" data-e="ribbonBtn" title="Guidance chevrons (V)">${ICON_RIBBON}</button>
      <button class="bbh-ribbon bbh-mapbtn" data-e="mapBtn" title="Route map (M)">${ICON_MAP}</button>
      <div class="bbh-panel bbh-sig" data-e="sig"><span class="bbh-lamps"><i class="r"></i><i class="a"></i><i class="g"></i></span><span data-t="sigd"></span></div>
      <div class="bbh-panel bbh-cluster" data-e="cluster">
        <div class="bbh-limit" data-t="limit">50</div>
        <div class="bbh-speed"><span class="v" data-t="speed">0</span><span class="u">km/h</span></div>
        <div class="bbh-row">
          <div class="bbh-gear"><span data-e="gR" class="r">R</span><span data-e="gN">N</span><span data-e="gD">D</span></div>
          <span class="bbh-tt ind" data-e="iL">${ICON_INDICATOR_L}</span>
          <span class="bbh-tt head" data-e="iH">${ICON_HEADLIGHT}</span>
          <span class="bbh-tt door" data-e="iD">${ICON_DOORS}</span>
          <span class="bbh-tt park" data-e="iP">${ICON_PARK}</span>
          <span class="bbh-tt haz" data-e="iZ">${ICON_HAZARD}</span>
          <span class="bbh-tt ind" data-e="iR">${ICON_INDICATOR_R}</span>
        </div>
      </div>
      <div class="bbh-panel bbh-off" data-e="off"><div class="bbh-oarrow" data-e="oarrow">${turnArrow('straight')}</div><div><div class="t1">Off route</div><div class="t2" data-t="offd"></div></div></div>
      <div class="bbh-panel bbh-dwell" data-e="dwell" aria-live="polite">
        <div class="bbh-dhead"><span class="bbh-dname" data-t="dname"></span><span class="bbh-dstat" data-e="dstat"></span></div>
        <div class="bbh-drow off" data-e="drOff"><span class="bbh-dlbl">${ICON_ALIGHT}<span>Alighting</span></span><span class="bbh-dbar"><b data-e="dbOff"></b></span><span class="bbh-dnum"><b data-t="dnOff"></b><small data-t="dtOff"></small></span></div>
        <div class="bbh-drow on" data-e="drOn"><span class="bbh-dlbl">${ICON_BOARD}<span>Boarding</span></span><span class="bbh-dbar"><b data-e="dbOn"></b></span><span class="bbh-dnum"><b data-t="dnOn"></b><small data-t="dtOn"></small></span></div>
      </div>
      <div class="bbh-panel bbh-prompt" data-e="prompt"></div>
      <div class="bbh-toasts"></div>
      <div class="bbh-map" data-e="map"><div class="bbh-panel bbh-mhead" data-e="mhead"></div>
        <div class="bbh-panel bbh-legend"><span><b style="background:#ffd23f"></b>Next stop</span><span><b style="background:#fff"></b>To serve</span><span><b style="background:#8dc63f"></b>Served</span><span><b style="background:#ff5a5a"></b>Missed</span><span><b style="background:#e463a4;border-radius:2px"></b>Other buses</span></div>
        <button class="bbh-close" data-e="mapClose">Close map · M</button></div>
      ${opts.showFps || /[?&]fps\b/.test(location.search) ? '<div class="bbh-fps" data-t="fps"></div>' : ''}`;
    host.appendChild(root);
    root.querySelectorAll<HTMLElement>('[data-t]').forEach((n) => (this.s[n.dataset.t!] = new TextSlot(n)));
    root.querySelectorAll<HTMLElement>('[data-e]').forEach((n) => (this.els[n.dataset.e!] = n));
    this.toasts = root.querySelector('.bbh-toasts')!;
    const e = this.els;
    this.f.turnShow = new FlagSlot(e.turn, 'show');
    this.f.turnSoon = new FlagSlot(e.turn, 'soon');
    this.f.stopping = new FlagSlot(e.next, 'stopping');
    this.f.at = new FlagSlot(e.next, 'at');
    this.f.over = new FlagSlot(e.cluster, 'over');
    this.f.off = new FlagSlot(e.off, 'show');
    this.f.prompt = new FlagSlot(e.prompt, 'show');
    this.f.dwell = new FlagSlot(e.dwell, 'show');
    this.f.dwellDone = new FlagSlot(e.dwell, 'done');
    this.f.dwellFull = new FlagSlot(e.dwell, 'full');
    this.f.offNone = new FlagSlot(e.drOff, 'none');
    this.f.onNone = new FlagSlot(e.drOn, 'none');
    this.f.loadBusy = new FlagSlot(e.load, 'busy');
    this.f.loadFull = new FlagSlot(e.load, 'full');
    this.f.night = new FlagSlot(root, 'night');
    this.f.cab = new FlagSlot(root, 'cab');
    this.f.map = new FlagSlot(e.map, 'show');
    this.f.ribbonOff = new FlagSlot(e.ribbonBtn, 'off');
    this.f.sig = new FlagSlot(e.sig, 'show');
    this.f.sigR = new FlagSlot(e.sig, 'red');
    this.f.sigA = new FlagSlot(e.sig, 'amber');
    this.f.sigG = new FlagSlot(e.sig, 'green');
    for (const k of ['gR', 'gN', 'gD', 'iL', 'iH', 'iD', 'iP', 'iZ', 'iR']) this.f[k] = new FlagSlot(e[k], 'on');
    e.mini.addEventListener('click', () => {
      if (!this.mini) return;
      this.mini.toggleZoom();
      this.s.zoom.set(this.mini.zoomLabel);
    });
    e.mapBtn.addEventListener('click', () => this.toggleMap());
    e.mapClose.addEventListener('click', () => this.toggleMap());
    e.ribbonBtn.addEventListener('click', () => (this.opts.guide ?? session.guide)?.toggleRibbon());
  }

  private setupRoute(route: Route): void {
    this.lastRoute = route;
    const color = brighten(route.color, 0.3);
    const b = this.els.badge;
    b.textContent = route.id;
    b.style.background = route.color;
    b.style.color = route.textColor;
    this.s.hs.set(route.headsign);
    this.mini?.canvas.remove();
    this.mini = new Minimap(this.data, route, color);
    this.els.mini.prepend(this.mini.canvas);
    this.full?.canvas.remove();
    this.full = new FullMap(this.data, route, color);
    this.els.map.prepend(this.full.canvas);
    this.els.mhead.innerHTML = `<span class="bbh-badge" style="background:${route.color};color:${route.textColor}">${escapeHtml(route.id)}</span><div><h3>${escapeHtml(route.headsign)}</h3><p>${escapeHtml(route.name)} · ${fmtDistance(route.length)} · ${route.stops.length} stops</p></div>`;
    // Stop ticks on the progress bar.
    const prog = this.els.progress;
    for (const t of this.stopTicks) t.remove();
    this.stopTicks = route.stops.map((st) => {
      const i = el('i');
      i.style.left = `${(100 * st.s) / Math.max(1, route.length)}%`;
      prog.appendChild(i);
      return i;
    });
    this.tickState = route.stops.map(() => -1);
  }

  update(f: HudFrame): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.lastFrame = f;
    session.hours = f.hours;
    if (f.route !== this.lastRoute) this.setupRoute(f.route);
    const g = f.guide;
    const s = this.s;
    const fl = this.f;
    // Sim seconds since the last frame (the time-of-day key jumps the clock by hours: not elapsed time).
    if (Number.isFinite(this.lastHours)) {
      const dh = ((((f.hours - this.lastHours) % 24) + 24) % 24) * 3600;
      if (dh < 60) this.simT += dh;
    }
    this.lastHours = f.hours;
    // In the cab the dashboard has the speedo, gear and lamps: the HUD keeps only the limit.
    fl.cab.set(f.cameraMode === 'cab');

    // Route card. Names that flick to a side street or the road below for a moment at a
    // junction are held back until they have lasted a moment; route refs are not names.
    const name = REF_ONLY.test(g.roadName.trim()) ? '' : g.roadName;
    const road = this.road.update(name, this.simT);
    s.road.set(road ? `on ${road}` : '');
    s.lvl.set(g.roadLevel === 'tunnel' ? 'Tunnel' : g.roadLevel === 'viaduct' ? 'Viaduct' : g.roadLevel === 'bridge' ? 'Bridge' : '');
    // Gradient over 4 % (with a little hysteresis so it does not flicker).
    const pct = Math.abs(g.grade) * 100;
    const showGrade = pct > (this.gradeShown ? 3 : 4);
    this.gradeShown = showGrade;
    const gtxt = showGrade ? `${g.grade > 0 ? '▲' : '▼'} ${Math.round(pct)}%` : '';
    if (gtxt !== this.gradeText) {
      this.gradeText = gtxt;
      const ge = this.els.slope;
      ge.textContent = gtxt;
      ge.classList.toggle('up', g.grade > 0);
      ge.title = showGrade ? `${g.grade > 0 ? 'Uphill' : 'Downhill'} grade ${Math.round(pct)}%` : '';
    }
    const prog = Math.round(g.progress * 1000) / 10;
    if (prog !== this.lastProgress) {
      this.lastProgress = prog;
      this.els.bar.style.width = `${prog}%`;
    }
    for (let i = 0; i < this.stopTicks.length; i++) {
      const st = i === g.nextStopIndex ? 9 : g.stopStatus[i];
      if (st !== this.tickState[i]) {
        this.tickState[i] = st;
        this.stopTicks[i].className = st === 9 ? 'next' : st === StopStatus.Served ? 'served' : st === StopStatus.Missed ? 'missed' : '';
      }
    }

    // Turn hint (or end of route).
    const toEnd = g.routeLength - g.s;
    let showTurn = false;
    if (!g.finished && !g.offRoute) {
      if (g.turn && g.turnDistance < 450 && g.turnDistance > -4 && g.turnDistance < toEnd) {
        showTurn = true;
        if (this.turnKey !== `t${g.turn.s}`) {
          this.turnKey = `t${g.turn.s}`;
          this.els.tarrow.innerHTML = turnArrow(g.turn.kind);
        }
        s.tdist.set(g.turnDistance < 15 ? 'Now' : fmtDistance(g.turnDistance));
        s.ttext.set(g.turn.text);
        fl.turnSoon.set(g.turnDistance < 60);
      } else if (toEnd < 400) {
        showTurn = true;
        if (this.turnKey !== 'end') {
          this.turnKey = 'end';
          this.els.tarrow.innerHTML = turnArrow('finish');
        }
        s.tdist.set(fmtDistance(toEnd));
        s.ttext.set('End of route ahead');
        fl.turnSoon.set(toEnd < 60);
      }
    }
    fl.turnShow.set(showTurn);

    // Next stop console.
    const hasNext = g.nextStopIndex >= 0 && !g.finished;
    s.ncap.set(hasNext ? (g.nextStopStation ? 'Next station' : 'Next stop') : 'Route complete');
    s.nno.set(!hasNext ? '' : g.nextStopNumber ? (g.nextStopStation ? `Platform ${g.nextStopNumber.replace(/^P/, '')}` : `Stop ${g.nextStopNumber}`) : `ID ${g.nextStopCode}`);
    s.nname.set(hasNext ? g.nextStopName : g.finished ? 'End of the line' : '');
    s.ndist.set(hasNext ? fmtDistance(Math.max(0, g.nextStopDistance)) : '');
    s.served.set(String(g.stopsServed));
    s.missed.set(String(g.stopsMissed));
    s.total.set(String(g.stopsTotal));
    const stopping = hasNext && g.nextStopDistance < 250;
    fl.stopping.set(stopping);
    fl.at.set(hasNext && g.atStop);
    s.stopping.set(hasNext && g.atStop ? (f.doorsOpen ? 'DOORS OPEN' : g.canServe ? 'AT STOP · OPEN DOORS' : 'STOP HERE') : 'BUS STOPPING');
    // Timetable.
    if (g.shiftStarted && this.departHours === null) this.departHours = f.hours - g.shiftTime / 3600;
    const pill = this.els.pill;
    let pillText = 'READY';
    let pillCls = 'bbh-pill idle';
    if (g.shiftStarted) {
      const d = g.scheduleDelta;
      if (d < -59) {
        pillText = `EARLY ${fmtDelta(-d).replace('+', '')}`;
        pillCls = 'bbh-pill early';
      } else if (d > 179) {
        pillText = `LATE ${fmtDelta(d).replace('+', '')}`;
        pillCls = 'bbh-pill late';
      } else {
        pillText = `ON TIME ${fmtDelta(d)}`;
        pillCls = 'bbh-pill';
      }
    }
    if (pill.textContent !== pillText) pill.textContent = pillText;
    if (pill.className !== pillCls) pill.className = pillCls;
    s.due.set(hasNext && this.departHours !== null ? `due ${fmtClock(this.departHours + g.nextStopDue / 3600)}` : hasNext ? `+${Math.round(g.nextStopDue / 60)} min` : '');

    // Clock.
    s.clock.set(fmtClock(f.hours));
    s.shift.set(g.shiftStarted ? fmtDuration(g.shiftTime) : '');
    fl.night.set(f.hours < 6.5 || f.hours > 18.2);
    // Load on board.
    const loadKey = `${g.load}/${g.capacity}`;
    if (loadKey !== this.loadKey) {
      this.loadKey = loadKey;
      s.load.set(String(g.load));
      s.cap.set(`/${g.capacity}`);
      const p = g.capacity > 0 ? g.load / g.capacity : 0;
      this.els.load.style.setProperty('--p', `${Math.round(Math.min(1, p) * 100)}%`);
      fl.loadBusy.set(p >= 0.8 && p < 1);
      fl.loadFull.set(p >= 1);
    }
    this.updateDwell(g.finished ? null : g.dwell);

    // Cluster.
    const kmh = Math.round(f.speedKmh);
    s.speed.set(String(kmh));
    // A limit seen for a moment (a slip lane's 10 km/h beside us) does not flash up.
    const limit = this.limit.update(g.speedLimit, this.simT);
    s.limit.set(String(limit));
    fl.over.set(g.speeding && f.speedKmh > limit + 5);
    fl.gR.set(f.gear === 'R');
    fl.gN.set(f.gear === 'N');
    fl.gD.set(f.gear === 'D');
    const blink = Math.floor(now / 380) % 2 === 0;
    const L = f.lights;
    fl.iL.set((L.indicatorLeft || L.hazards) && blink);
    fl.iR.set((L.indicatorRight || L.hazards) && blink);
    fl.iH.set(L.headlights);
    fl.iD.set(f.doorsOpen);
    fl.iP.set(!!f.parkBrake);
    fl.iZ.set(L.hazards);
    fl.ribbonOff.set(!g.ribbonVisible);

    // Traffic signal ahead.
    const sig = !g.finished ? g.signal : null;
    fl.sig.set(!!sig);
    if (sig) {
      fl.sigR.set(sig.state === 'red');
      fl.sigA.set(sig.state === 'amber');
      fl.sigG.set(sig.state === 'green');
      s.sigd.set(fmtDistance(sig.distance));
    }

    // Off route.
    const [px, py] = this.busCentre(f.pose);
    fl.off.set(g.offRoute && !g.finished);
    if (g.offRoute) {
      const ang = Math.atan2(g.rejoinX - px, g.rejoinY - py) - f.pose.heading;
      const deg = Math.round((ang * 180) / Math.PI);
      if (deg !== this.offAngle) {
        this.offAngle = deg;
        this.els.oarrow.style.transform = `rotate(${deg}deg)`;
      }
      s.offd.set(`Return to route · ${fmtDistance(g.routeDistance)}`);
    }

    // Contextual prompt.
    let prompt = '';
    if (!g.finished && !this.mapOpen) {
      if (g.dwell) prompt = dwellPrompt(g.dwell, g);
      else if (g.canBoard && !f.doorsOpen) prompt = 'Passengers waiting · open the doors <kbd>O</kbd> to let them board';
      else if (!g.shiftStarted && Math.abs(f.speedKmh) < 1.5 && f.doorsOpen) prompt = 'Close the doors <kbd>O</kbd> when ready';
      else if (!g.shiftStarted && Math.abs(f.speedKmh) < 1.5) prompt = f.parkBrake ? 'Ready to depart · release the park brake <kbd>F</kbd> and pull out' : 'Ready to depart · indicate <kbd>E</kbd> and pull out when clear';
      else if (hasNext && g.canServe && !f.doorsOpen) prompt = `Open the doors <kbd>O</kbd> to serve ${escapeHtml(g.nextStopName)}`;
      else if (hasNext && g.atStop && !f.doorsOpen && f.speedKmh > 2) prompt = 'Stop at the flag to serve this stop';
      else if (f.doorsOpen && f.speedKmh < 1 && g.shiftStarted && !g.atStop && g.scheduleDelta < -59)
        prompt = `Running early · hold here for ${fmtDelta(-g.scheduleDelta).replace('+', '')}`;
      else if (f.doorsOpen && f.speedKmh < 1 && g.shiftStarted && !g.atStop) prompt = 'Close the doors <kbd>O</kbd> when ready';
    }
    if (prompt) {
      if (this.els.prompt.innerHTML !== prompt) this.els.prompt.innerHTML = prompt;
    }
    fl.prompt.set(!!prompt);

    // Events -> toasts.
    for (const ev of g.events) {
      if (ev.id <= this.lastEvent) continue;
      this.lastEvent = ev.id;
      switch (ev.kind) {
        case 'served': {
          const d = ev.delta ?? 0;
          const when = d < -59 ? `${fmtDelta(-d).replace('+', '')} early` : d > 179 ? `${fmtDelta(d).replace('+', '')} late` : 'on time';
          this.toast(`${ev.text} <small>${when}</small>`, d < -59 || d > 179 ? 'warn' : 'good', true);
          break;
        }
        case 'missed':
        case 'collision':
        case 'leftbehind':
          this.toast(ev.text, 'bad');
          break;
        case 'full':
          this.toast(ev.text, 'warn');
          break;
        case 'offroute':
          // The Off route card says it (and points the way back).
          this.offStartT = this.simT;
          break;
        case 'onroute':
          // Only after a real spell off the route, and not every time the line is grazed.
          if (this.simT - this.offStartT >= 3 && this.simT - this.lastOnToastT >= 10) {
            this.lastOnToastT = this.simT;
            this.toast(ev.text, 'good');
          }
          break;
        case 'finished':
          this.summaryTimer = 1.4;
          break;
        default:
          this.toast(ev.text, 'info');
      }
    }
    if (this.summaryTimer > 0) {
      this.summaryTimer -= dt;
      if (this.summaryTimer <= 0 && g.summary && !this.summaryShown) this.showSummary(g.summary);
    }

    // Minimap (~30 Hz) and full map (~8 Hz).
    const markers = f.vehicles ?? (this.opts.traffic ?? session.traffic)?.markers() ?? [];
    this.miniAcc += dt;
    if (this.mini && this.miniAcc >= 1 / 30 && !this.mapOpen) {
      this.mini.draw(this.miniAcc, px, py, f.pose.heading, g.stopStatus, g.finished ? -1 : g.nextStopIndex, markers);
      this.miniAcc = 0;
      const deg = Math.round((-f.pose.heading * 180) / Math.PI);
      if (deg !== this.nAngle) {
        this.nAngle = deg;
        const R = this.els.mini.clientWidth / 2 - 2;
        const a = -f.pose.heading;
        this.els.north.style.transform = `translate(${(Math.sin(a) * R).toFixed(1)}px, ${(-Math.cos(a) * R).toFixed(1)}px)`;
      }
    }
    if (this.mapOpen && this.full) {
      this.fullAcc += dt;
      if (this.fullAcc >= 1 / 8) {
        this.full.draw(this.fullAcc, g, px, py, f.pose.heading, markers);
        this.fullAcc = 0;
      }
    }
    if (s.fps) s.fps.set(`${Math.round(f.fps)} fps · ${f.cameraMode}`);
  }

  /** Passenger panel: alighting bar empties, boarding bar fills. */
  private updateDwell(d: DwellState | null): void {
    const fl = this.f;
    fl.dwell.set(!!d);
    if (!d) {
      this.dwellKey = '';
      this.dwellStop = -1;
      return;
    }
    const key = `${d.stop}|${d.alighting}|${d.boarding}|${d.done}|${d.full}|${d.doors}|${d.flowing}`;
    if (key === this.dwellKey) return;
    this.dwellKey = key;
    const s = this.s;
    const e = this.els;
    s.dname.set(d.stopName);
    s.dnOff.set(d.alightTotal ? String(d.alighting) : '–');
    s.dtOff.set(d.alightTotal ? ` of ${d.alightTotal}` : '');
    s.dnOn.set(d.boardTotal ? String(d.boarding) : '–');
    s.dtOn.set(d.boardTotal ? ` of ${d.boardTotal}` : '');
    e.dbOff.style.width = `${d.alightTotal ? ((100 * d.alighting) / d.alightTotal).toFixed(1) : 0}%`;
    e.dbOn.style.width = `${d.boardTotal ? ((100 * d.boarding) / d.boardTotal).toFixed(1) : 0}%`;
    if (d.stop !== this.dwellStop) {
      // A new stop: one notch per passenger when there are few enough to count.
      this.dwellStop = d.stop;
      for (const [b, n] of [[e.dbOff, d.alightTotal], [e.dbOn, d.boardTotal]] as const) {
        const bar = b.parentElement!;
        bar.classList.toggle('ticks', n > 1 && n <= 24);
        bar.style.setProperty('--n', String(Math.max(1, n)));
      }
    }
    fl.offNone.set(!d.alightTotal);
    fl.onNone.set(!d.boardTotal);
    fl.dwellDone.set(d.done);
    fl.dwellFull.set(d.full > 0);
    const [txt, cls] = d.done
      ? d.full > 0
        ? [`Bus full · ${d.full} left`, 'bad']
        : d.last
          ? ['All off', 'ok']
          : ['All aboard', 'ok']
      : d.doors === 'closing'
        ? ['Doors closing', 'bad']
        : d.doors === 'opening'
          ? ['Doors opening', '']
          : d.alighting > 0
            ? ['Getting off', 'off']
            : ['Boarding', 'on'];
    if (e.dstat.textContent !== txt) e.dstat.textContent = txt;
    const c = `bbh-dstat ${cls}`;
    if (e.dstat.className !== c) e.dstat.className = c;
  }

  private busCentre(p: BusPose): [number, number] {
    return [p.x + Math.sin(p.heading) * 3, p.y + Math.cos(p.heading) * 3];
  }

  toast(msg: string, kind: ToastKind = 'info', html = false): void {
    // The same message again while it is still up: count it instead of stacking a copy.
    const key = `${kind}|${msg}`;
    const same = this.live.find((x) => x.key === key);
    if (same) {
      same.n++;
      if (!same.badge) {
        same.badge = el('b', 'bbh-tn');
        same.el.appendChild(same.badge);
      }
      same.badge.textContent = `×${same.n}`;
      clearTimeout(same.timer);
      same.timer = this.expire(same);
      return;
    }
    const t = el('div', `bbh-panel bbh-toast ${kind}`);
    const i = el('i');
    const span = el('span');
    if (html) span.innerHTML = msg;
    else span.textContent = msg;
    t.append(i, span);
    this.toasts.appendChild(t);
    const lt: LiveToast = { el: t, key, n: 1, timer: 0, badge: null };
    lt.timer = this.expire(lt);
    this.live.push(lt);
    // Small screens keep two, so the stack never reaches the cards below it.
    const max = matchMedia('(max-height: 560px), (max-width: 760px)').matches ? 2 : 3;
    while (this.live.length > max) {
      const old = this.live.shift()!;
      clearTimeout(old.timer);
      old.el.remove();
    }
  }

  private expire(lt: LiveToast): number {
    return window.setTimeout(() => {
      this.live = this.live.filter((x) => x !== lt);
      lt.el.classList.add('out');
      setTimeout(() => lt.el.remove(), 360);
    }, TOAST_MS);
  }

  toggleMap(): void {
    this.mapOpen = !this.mapOpen;
    this.f.map.set(this.mapOpen);
    if (this.mapOpen && this.full && this.lastFrame) {
      requestAnimationFrame(() => {
        const f = this.lastFrame;
        if (!f || !this.full) return;
        const [px, py] = this.busCentre(f.pose);
        this.full.draw(0, f.guide, px, py, f.pose.heading, f.vehicles ?? (this.opts.traffic ?? session.traffic)?.markers() ?? []);
      });
    }
  }

  get isMapOpen(): boolean {
    return this.mapOpen;
  }

  showSummary(sum: RouteSummary): void {
    if (this.summaryShown) return;
    this.summaryShown = true;
    const r = this.lastRoute;
    const wrap = el('div', 'bbh-sum');
    const avg = sum.avgDelta;
    const avgTxt = Math.abs(avg) < 30 ? 'on time' : avg > 0 ? `${fmtDelta(avg).replace('+', '')} late` : `${fmtDelta(-avg).replace('+', '')} early`;
    const headline = sum.grade === 'A' ? 'Outstanding shift!' : sum.grade === 'B' ? 'Great shift' : sum.grade === 'C' ? 'Shift complete' : 'Shift complete — room to improve';
    wrap.innerHTML = `<div class="bbh-panel" role="dialog" aria-label="Shift summary">
      <div class="bbh-shead">${r ? `<span class="bbh-badge" style="background:${r.color};color:${r.textColor}">${escapeHtml(r.id)}</span>` : ''}
        <div><h2>${headline}</h2><div class="bbh-sub">Route ${escapeHtml(sum.routeId)} to ${escapeHtml(sum.headsign)}</div></div>
        <div class="bbh-grade" style="--p:${sum.score}"><span>${sum.grade}</span><small>${sum.score}/100</small></div></div>
      <div class="bbh-sgrid">
        <div><div class="k">Stops served</div><div class="v">${sum.stopsServed}<small> / ${sum.stopsTotal - sum.stopsSkipped}</small></div></div>
        <div><div class="k">Missed</div><div class="v">${sum.stopsMissed}</div></div>
        <div><div class="k">Punctuality</div><div class="v">${sum.punctuality}<small>%</small></div></div>
        <div><div class="k">Average</div><div class="v" style="font-size:18px">${avgTxt}</div></div>
        <div><div class="k">Collisions</div><div class="v">${sum.collisions}</div></div>
        <div><div class="k">Speeding</div><div class="v">${Math.round(sum.speedingSeconds)}<small> s</small></div></div>
        <div><div class="k">Distance</div><div class="v">${(sum.distance / 1000).toFixed(1)}<small> km</small></div></div>
        <div><div class="k">Shift time</div><div class="v">${fmtDuration(sum.time)}</div></div>
        <div><div class="k">Worst late</div><div class="v">${fmtDelta(sum.worstLate).replace('+', '')}</div></div>
        <div><div class="k">Passengers</div><div class="v">${sum.passengersCarried}<small> carried</small></div></div>
        <div><div class="k">Left behind</div><div class="v">${sum.passengersLeft}${sum.passengersFull ? `<small> +${sum.passengersFull} bus full</small>` : ''}</div></div>
        <div title="Boarding time beyond the timetable's allowance is not counted against you"><div class="k">Crowd delay</div><div class="v">${fmtDuration(sum.passengerDelay)}<small> excused</small></div></div>
      </div>
      <div class="bbh-sbtns"><button data-a="keep">Keep driving</button><button class="primary" data-a="again">Drive another route</button></div>
    </div>`;
    wrap.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-a]')?.dataset.a;
      if (a === 'again') location.href = location.pathname;
      else if (a === 'keep') wrap.remove();
    });
    this.root.appendChild(wrap);
    wrap.querySelector<HTMLButtonElement>('.primary')?.focus();
  }

  dispose(): void {
    this.root.remove();
  }
}

/** The prompt while passengers get off and on: kneel requests, then when to close the doors. */
function dwellPrompt(d: DwellState, g: GuideState): string {
  if (!d.done) {
    const n = d.alighting + d.boardTotal - d.boarding;
    if (d.doors === 'closing') return `Doors closing on ${n} passenger${n === 1 ? '' : 's'} · <kbd>O</kbd> to reopen`;
    return d.kneelFor ? `Kneel the bus <kbd>K</kbd> for a passenger ${escapeHtml(d.kneelFor)}` : '';
  }
  if (d.last) return 'End of the line · all passengers off';
  if (g.shiftStarted && g.scheduleDelta < -59) return `All aboard · running early, hold for ${fmtDelta(-g.scheduleDelta).replace('+', '')}`;
  if (d.doors === 'closing') return '';
  return d.full > 0 ? 'Bus full · close the doors <kbd>O</kbd>' : 'All aboard — close the doors <kbd>O</kbd>';
}
