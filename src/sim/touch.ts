/**
 * On-screen controls for phones and tablets: a steering wheel (drag the rim to
 * turn, it springs back; tap the hub for the horn), brake and accelerator
 * pedals (press lower for more), a compact switch row (indicators, doors,
 * gear, view) and a drawer with the rest. Only created on touch devices (or
 * with ?touch=1).
 *
 * While shown, <html> gets the class `bsim-touch` and the CSS variable
 * `--bsim-touch-reserve` (px) = height of the bottom strip these controls use,
 * so HUD panels can sit above them.
 */
import type { DriveInput, InputAction } from '../types';
import { telemetry } from './hub';

const STYLE_ID = 'bsim-touch-style';
const CSS = `
html.bsim-touch{--bsim-touch-reserve:calc(var(--bsim-s,150px) + 30px)}
#bsim-touch{position:fixed;inset:0;pointer-events:none;z-index:30;user-select:none;-webkit-user-select:none;
  -webkit-touch-callout:none;touch-action:none;font:600 11px/1 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#f2f6fb;
  --s:var(--bsim-s,150px);--teal:#00a5b5;--amber:#ffb020;--red:#ff4d4d;--glass:rgba(8,18,34,.55);--pad:12px}
#bsim-touch *{box-sizing:border-box}
#bsim-touch .g{pointer-events:auto;background:var(--glass);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
  border:1px solid rgba(255,255,255,.16);box-shadow:0 8px 28px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.08)}
#bsim-touch .wheel{position:absolute;left:calc(var(--pad) + env(safe-area-inset-left));bottom:calc(var(--pad) + env(safe-area-inset-bottom));
  width:var(--s);height:var(--s);border-radius:50%;padding:5px;touch-action:none}
#bsim-touch .wheel svg{width:100%;height:100%;display:block;will-change:transform;filter:drop-shadow(0 3px 6px rgba(0,0,0,.45))}
#bsim-touch .wheel.horn .hub{fill:#00a5b5}
#bsim-touch .pedals{position:absolute;right:calc(var(--pad) + env(safe-area-inset-right));bottom:calc(var(--pad) + env(safe-area-inset-bottom));
  display:flex;gap:10px;align-items:flex-end}
#bsim-touch .pedal{position:relative;border-radius:16px;overflow:hidden;touch-action:none;display:flex;align-items:flex-end;justify-content:center}
#bsim-touch .pedal.brake{width:calc(var(--s)*.5);height:calc(var(--s)*.72)}
#bsim-touch .pedal.accel{width:calc(var(--s)*.4);height:var(--s)}
#bsim-touch .pedal .fill{position:absolute;left:0;right:0;bottom:0;height:0;opacity:.85}
#bsim-touch .pedal.brake .fill{background:linear-gradient(0deg,rgba(255,77,77,.85),rgba(255,77,77,.2))}
#bsim-touch .pedal.accel .fill{background:linear-gradient(0deg,rgba(0,165,181,.9),rgba(141,198,63,.3))}
#bsim-touch .pedal .ribs{position:absolute;inset:9px;background:repeating-linear-gradient(180deg,rgba(255,255,255,.13) 0 3px,transparent 3px 11px);border-radius:10px}
#bsim-touch .pedal span{position:relative;margin-bottom:9px;letter-spacing:.12em;font-size:9px;opacity:.9}
#bsim-touch .pedal.on{border-color:rgba(255,255,255,.45)}
#bsim-touch .bar{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(var(--pad) + env(safe-area-inset-bottom));
  display:flex;gap:7px;align-items:center;padding:6px;border-radius:18px}
#bsim-touch .b{pointer-events:auto;width:46px;height:46px;border-radius:13px;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:3px;touch-action:none;transition:background .12s,border-color .12s,transform .08s;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12)}
#bsim-touch .b svg{width:21px;height:21px}
#bsim-touch .b small{font-size:7.5px;letter-spacing:.08em;opacity:.8}
#bsim-touch .b.down{transform:scale(.92);background:rgba(255,255,255,.2)}
#bsim-touch .b.amber{background:rgba(255,176,32,.6);border-color:var(--amber)}
#bsim-touch .b.red{background:rgba(255,77,77,.5);border-color:var(--red)}
#bsim-touch .b.teal{background:rgba(0,165,181,.5);border-color:var(--teal)}
#bsim-touch .gear{pointer-events:auto;display:flex;border-radius:13px;overflow:hidden;height:46px;border:1px solid rgba(255,255,255,.12)}
#bsim-touch .gear div{width:32px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;opacity:.5;touch-action:none}
#bsim-touch .gear div.sel{opacity:1;background:rgba(0,165,181,.6)}
#bsim-touch .gear div.sel.r{background:rgba(255,77,77,.6)}
#bsim-touch .drawer{position:absolute;left:50%;transform:translateX(-50%) translateY(8px);opacity:0;visibility:hidden;
  bottom:calc(var(--pad) + 70px + env(safe-area-inset-bottom));display:grid;grid-template-columns:repeat(4,46px);gap:7px;padding:8px;border-radius:18px;
  transition:opacity .15s,transform .15s,visibility .15s}
#bsim-touch .drawer.open{opacity:1;visibility:visible;transform:translateX(-50%)}
@media (orientation:portrait){
  html.bsim-touch{--bsim-touch-reserve:calc(var(--bsim-s,150px) + 96px)}
  #bsim-touch .bar{bottom:calc(var(--s) + var(--pad) * 2 + env(safe-area-inset-bottom))}
  #bsim-touch .drawer{bottom:calc(var(--s) + var(--pad) * 2 + 70px + env(safe-area-inset-bottom))}
}
`;

const svg = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  left: svg('<path d="M15 5 6 12l9 7z" fill="currentColor" stroke="none"/>'),
  right: svg('<path d="M9 5l9 7-9 7z" fill="currentColor" stroke="none"/>'),
  hazard: svg('<path d="M12 3 2.5 20h19z"/><path d="M12 9.5 7.6 17h8.8z"/>'),
  doors: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M8 12H5m3 0-1.5-1.5M8 12l-1.5 1.5M16 12h3m-3 0 1.5-1.5M16 12l1.5 1.5"/>'),
  kneel: svg('<path d="M12 4v10m0 0-4-4m4 4 4-4M4 20h16"/>'),
  horn: svg('<path d="M3 10v4h4l6 4V6L7 10z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'),
  park: svg('<circle cx="12" cy="12" r="9"/><path d="M10 16V8h3a2.5 2.5 0 0 1 0 5h-3"/>'),
  lights: svg('<path d="M10 6c-4 0-6 2.7-6 6s2 6 6 6c1.5 0 2-1.5 2-6s-.5-6-2-6z"/><path d="M15 8h6M15 12h6M15 16h6"/>'),
  cam: svg('<path d="M3 7h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3z"/><path d="m16 11 5-3v8l-5-3"/>'),
  map: svg('<path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>'),
  pause: svg('<path d="M8 5v14M16 5v14"/>'),
  reset: svg('<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/>'),
  more: svg('<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>'),
  time: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
};

const WHEEL_SVG = `<svg viewBox="-100 -100 200 200">
  <defs>
    <radialGradient id="bsimHub" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#3a4a5e"/><stop offset="1" stop-color="#151d28"/></radialGradient>
    <linearGradient id="bsimRim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4b5563"/><stop offset=".5" stop-color="#1f2937"/><stop offset="1" stop-color="#0b1119"/></linearGradient>
  </defs>
  <circle r="84" fill="none" stroke="url(#bsimRim)" stroke-width="20"/>
  <circle r="84" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="1.5" stroke-dasharray="3 7"/>
  <path d="M-80-12 L-26-8 M80-12 L26-8 M0 30 L0 78" stroke="#2b3644" stroke-width="16" stroke-linecap="round"/>
  <circle class="hub" r="32" fill="url(#bsimHub)" stroke="#00a5b5" stroke-width="3"/>
  <g transform="translate(-12 -12)" stroke="rgba(255,255,255,.55)" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 10v4h4l6 4V6L7 10z"/><path d="M16 9a4 4 0 0 1 0 6"/>
  </g>
  <rect x="-6" y="-102" width="12" height="20" rx="3" fill="#00a5b5"/>
</svg>`;

interface ButtonDef {
  action: InputAction;
  icon: string;
  label: string;
  key: string;
  hold?: boolean;
}

function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    // Pointer already gone (or synthetic): the element still gets its own events.
  }
}

export class TouchControls {
  readonly root: HTMLDivElement;
  throttle = 0;
  brake = 0;
  steer = 0;
  steering = false;
  /** Pending edge actions (consumed by InputManager.poll). */
  readonly pressed: InputAction[] = [];
  readonly held = new Set<InputAction>();
  gearRequest: DriveInput['gear'] | null = null;

  private wheelEl: HTMLDivElement;
  private wheelSvg: SVGElement;
  private wheelRot = 0; // degrees
  private wheelGrab: { id: number; start: number; rot0: number } | null = null;
  private hornId = -1;
  private buttons = new Map<string, HTMLDivElement>();
  private gearEls: Record<DriveInput['gear'], HTMLDivElement>;
  private brakeFill: HTMLDivElement;
  private accelFill: HTMLDivElement;
  private drawer: HTMLDivElement;
  private onResize = () => this.layout();

  constructor(parent: HTMLElement = document.body) {
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const root = document.createElement('div');
    root.id = 'bsim-touch';
    this.root = root;

    // Steering wheel (hub = horn)
    this.wheelEl = document.createElement('div');
    this.wheelEl.className = 'wheel g';
    this.wheelEl.innerHTML = WHEEL_SVG;
    this.wheelSvg = this.wheelEl.querySelector('svg') as SVGElement;
    root.appendChild(this.wheelEl);
    this.bindWheel();

    // Pedals
    const pedals = document.createElement('div');
    pedals.className = 'pedals';
    const brake = this.makePedal('brake', 'BRAKE', (v) => (this.brake = v));
    const accel = this.makePedal('accel', 'ACCEL', (v) => (this.throttle = v));
    this.brakeFill = brake.querySelector('.fill') as HTMLDivElement;
    this.accelFill = accel.querySelector('.fill') as HTMLDivElement;
    pedals.append(brake, accel);
    root.appendChild(pedals);

    // Primary switch row
    const bar = document.createElement('div');
    bar.className = 'bar g';
    bar.appendChild(this.makeButton({ key: 'il', action: 'indicatorLeft', icon: ICON.left, label: 'IND' }));
    bar.appendChild(this.makeButton({ key: 'dr', action: 'doors', icon: ICON.doors, label: 'DOORS' }));
    bar.appendChild(this.makeButton({ key: 'ir', action: 'indicatorRight', icon: ICON.right, label: 'IND' }));
    const gear = document.createElement('div');
    gear.className = 'gear';
    const mk = (g: DriveInput['gear']) => {
      const el = document.createElement('div');
      el.textContent = g;
      if (g === 'R') el.classList.add('r');
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.gearRequest = g;
        navigator.vibrate?.(8);
      });
      gear.appendChild(el);
      return el;
    };
    this.gearEls = { R: mk('R'), N: mk('N'), D: mk('D') };
    bar.appendChild(gear);
    bar.appendChild(this.makeButton({ key: 'cm', action: 'camera', icon: ICON.cam, label: 'VIEW' }));
    const more = document.createElement('div');
    more.className = 'b';
    more.innerHTML = `${ICON.more}<small>MORE</small>`;
    more.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.drawer.classList.toggle('open');
      more.classList.toggle('teal', this.drawer.classList.contains('open'));
    });
    bar.appendChild(more);
    root.appendChild(bar);

    // Drawer with the less frequent switches
    this.drawer = document.createElement('div');
    this.drawer.className = 'drawer g';
    const defs: ButtonDef[] = [
      { key: 'hz', action: 'hazards', icon: ICON.hazard, label: 'HAZARD' },
      { key: 'kn', action: 'kneel', icon: ICON.kneel, label: 'KNEEL' },
      { key: 'pb', action: 'parkBrake', icon: ICON.park, label: 'P-BRAKE' },
      { key: 'hl', action: 'headlights', icon: ICON.lights, label: 'LIGHTS' },
      { key: 'hn', action: 'horn', icon: ICON.horn, label: 'HORN', hold: true },
      { key: 'mp', action: 'map', icon: ICON.map, label: 'MAP' },
      { key: 'tm', action: 'timeOfDay', icon: ICON.time, label: 'TIME' },
      { key: 'rs', action: 'reset', icon: ICON.reset, label: 'RESET' },
      { key: 'ps', action: 'pause', icon: ICON.pause, label: 'PAUSE' },
    ];
    for (const d of defs) this.drawer.appendChild(this.makeButton(d));
    root.appendChild(this.drawer);

    root.addEventListener('contextmenu', (e) => e.preventDefault());
    parent.appendChild(root);
    document.documentElement.classList.add('bsim-touch');
    addEventListener('resize', this.onResize);
    this.layout();
  }

  /** Per-frame: spring the wheel back, refresh lamp states. */
  update(dt: number, gear: DriveInput['gear']): void {
    if (!this.wheelGrab) {
      this.wheelRot *= Math.exp(-dt * 3.2);
      if (Math.abs(this.wheelRot) < 0.2) this.wheelRot = 0;
    }
    this.steer = Math.max(-1, Math.min(1, this.wheelRot / 180));
    this.wheelSvg.style.transform = `rotate(${this.wheelRot.toFixed(1)}deg)`;
    this.brakeFill.style.height = `${(this.brake * 100).toFixed(0)}%`;
    this.accelFill.style.height = `${(this.throttle * 100).toFixed(0)}%`;
    const t = telemetry;
    const flash = t.flasherOn;
    this.toggle('il', 'amber', (t.indicatorLeft || t.hazards) && flash);
    this.toggle('ir', 'amber', (t.indicatorRight || t.hazards) && flash);
    this.toggle('hz', 'red', t.hazards);
    this.toggle('dr', 'teal', t.doorsWanted || t.doorOpen > 0.02);
    this.toggle('kn', 'teal', t.kneel > 0.02);
    this.toggle('pb', 'red', t.parkBrake);
    this.toggle('hl', 'teal', t.headlights);
    for (const g of ['R', 'N', 'D'] as const) this.gearEls[g].classList.toggle('sel', g === gear);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
    document.documentElement.classList.toggle('bsim-touch', v);
  }

  dispose(): void {
    removeEventListener('resize', this.onResize);
    document.documentElement.classList.remove('bsim-touch');
    this.root.remove();
  }

  /** Size the wheel / pedals from the viewport (shared with the HUD via --bsim-s). */
  private layout(): void {
    const vmin = Math.min(innerWidth, innerHeight);
    const s = Math.round(Math.max(112, Math.min(184, vmin * 0.3)));
    document.documentElement.style.setProperty('--bsim-s', `${s}px`);
  }

  private toggle(key: string, cls: string, on: boolean): void {
    this.buttons.get(key)?.classList.toggle(cls, on);
  }

  private makeButton(d: ButtonDef): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'b';
    el.innerHTML = `${d.icon}<small>${d.label}</small>`;
    this.buttons.set(d.key, el);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(el, e.pointerId);
      el.classList.add('down');
      this.pressed.push(d.action);
      if (d.hold) this.held.add(d.action);
      navigator.vibrate?.(8);
    });
    const up = () => {
      el.classList.remove('down');
      if (d.hold) this.held.delete(d.action);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return el;
  }

  private makePedal(cls: string, label: string, set: (v: number) => void): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `pedal ${cls} g`;
    el.innerHTML = `<div class="fill"></div><div class="ribs"></div><span>${label}</span>`;
    let id = -1;
    const value = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const f = (e.clientY - r.top) / Math.max(1, r.height);
      return Math.max(0.2, Math.min(1, 0.2 + f * 0.85));
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      id = e.pointerId;
      capture(el, id);
      el.classList.add('on');
      set(value(e));
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId === id) set(value(e));
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      el.classList.remove('on');
      set(0);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return el;
  }

  private bindWheel(): void {
    const el = this.wheelEl;
    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      return { angle: (Math.atan2(dx, -dy) * 180) / Math.PI, radius: Math.hypot(dx, dy) / (r.width / 2) };
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(el, e.pointerId);
      const p = local(e);
      if (p.radius < 0.36 && !this.wheelGrab) {
        // Hub: horn.
        this.hornId = e.pointerId;
        this.held.add('horn');
        this.pressed.push('horn');
        el.classList.add('horn');
        return;
      }
      if (this.wheelGrab) return;
      this.wheelGrab = { id: e.pointerId, start: p.angle, rot0: this.wheelRot };
      this.steering = true;
    });
    el.addEventListener('pointermove', (e) => {
      const g = this.wheelGrab;
      if (!g || e.pointerId !== g.id) return;
      const a = local(e).angle;
      let d = a - g.start;
      // Unwrap across the +-180 seam, accumulating for hand-over-hand turns.
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      this.wheelRot = Math.max(-200, Math.min(200, g.rot0 + d));
      if (Math.abs(d) > 90) {
        g.start = a;
        g.rot0 = this.wheelRot;
      }
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId === this.hornId) {
        this.hornId = -1;
        this.held.delete('horn');
        el.classList.remove('horn');
      }
      if (this.wheelGrab?.id !== e.pointerId) return;
      this.wheelGrab = null;
      this.steering = false;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
}
