/**
 * Keyboard, mouse, gamepad and touch input merged into one DriveInput per
 * frame. Digital inputs are shaped like a real cab: the throttle rolls on, the
 * brake pedal is progressive (a tap is a gentle brake, holding builds to full),
 * and the steering wheel turns at a hand-over-hand rate that slows with speed
 * and self-centres when released.
 */
import type { DriveInput, InputAction } from '../types';
import { emitSimAny, telemetry, type SimInput } from './hub';
import { TouchControls } from './touch';

/** Key code -> edge/held action. */
export const KEY_ACTIONS: Record<string, InputAction> = {
  KeyO: 'doors',
  Space: 'doors',
  KeyK: 'kneel',
  KeyH: 'horn',
  KeyQ: 'indicatorLeft',
  KeyE: 'indicatorRight',
  KeyZ: 'hazards',
  KeyL: 'headlights',
  KeyC: 'camera',
  Comma: 'lookLeft',
  Period: 'lookRight',
  Slash: 'lookBack',
  KeyM: 'map',
  KeyP: 'pause',
  Escape: 'pause',
  KeyT: 'timeOfDay',
  KeyF: 'parkBrake',
  Backspace: 'reset',
  PageUp: 'gearUp',
  PageDown: 'gearDown',
};

/** Standard-mapping gamepad button -> action. */
const PAD_ACTIONS: Record<number, InputAction> = {
  0: 'doors', // A
  1: 'parkBrake', // B
  2: 'horn', // X (held)
  3: 'camera', // Y
  4: 'indicatorLeft', // LB
  5: 'indicatorRight', // RB
  8: 'map', // Back / View
  9: 'pause', // Start / Menu
  10: 'kneel', // L3
  11: 'hazards', // R3
  12: 'gearUp', // D-pad up
  13: 'gearDown', // D-pad down
  14: 'headlights', // D-pad left
  15: 'reset', // D-pad right
};

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Slash', 'PageUp', 'PageDown', 'Quote']);

function typingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable;
}

export interface InputOptions {
  /** 'auto' (default) shows touch controls on coarse-pointer devices or after the first touch; true forces them. */
  touch?: boolean | 'auto';
}

export class InputManager {
  /** Gear selector position. Change it with selectGear() to get the interlocks. */
  gear: DriveInput['gear'] = 'D';
  /** Last device used for steering. */
  device: SimInput['device'] = 'keyboard';
  touch: TouchControls | null = null;

  private keys = new Set<string>();
  private queue: string[] = [];
  private shift = false;
  private throttleKb = 0;
  private brakeKb = 0;
  private steerKb = 0;
  private steerPad = 0;
  private steerOut = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private drag: { id: number; x: number; y: number } | null = null;
  private releasedAt = -10;
  private zoomAcc = 0;
  private padPrev: boolean[] = [];
  private padLook = false;
  private time = 0;
  private disposers: (() => void)[] = [];

  constructor(opts: InputOptions = {}) {
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, o?: AddEventListenerOptions) => {
      addEventListener(type, fn, o);
      this.disposers.push(() => removeEventListener(type, fn, o));
    };
    on('keydown', (e) => {
      if (typingTarget(e.target)) return;
      if (PREVENT.has(e.code)) e.preventDefault();
      this.shift = e.shiftKey;
      if (!e.repeat) this.queue.push(e.code);
      this.keys.add(e.code);
    });
    on('keyup', (e) => {
      this.shift = e.shiftKey;
      this.keys.delete(e.code);
    });
    on('blur', () => this.keys.clear());

    // Mouse / touch drag on the 3D canvas = free look.
    const isScene = (t: EventTarget | null) =>
      t instanceof HTMLCanvasElement && (t.closest('#app') !== null || document.getElementById('app') === null);
    on('pointerdown', (e) => {
      if (!isScene(e.target) || this.drag) return;
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try {
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      } catch {
        // ignore: capture is a nicety
      }
    });
    on('pointermove', (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      const k = e.pointerType === 'touch' ? 0.006 : 0.0045;
      this.lookYaw = Math.max(-2.95, Math.min(2.95, this.lookYaw - (e.clientX - d.x) * k));
      this.lookPitch = Math.max(-0.75, Math.min(0.6, this.lookPitch - (e.clientY - d.y) * k * 0.8));
      d.x = e.clientX;
      d.y = e.clientY;
    });
    const up = (e: PointerEvent) => {
      if (this.drag && e.pointerId === this.drag.id) {
        this.drag = null;
        this.releasedAt = this.time;
      }
    };
    on('pointerup', up);
    on('pointercancel', up);
    on('dblclick', (e) => {
      if (isScene(e.target)) {
        this.lookYaw = 0;
        this.lookPitch = 0;
      }
    });
    on('contextmenu', (e) => {
      if (isScene(e.target)) e.preventDefault();
    });
    on(
      'wheel',
      (e) => {
        if (isScene(e.target)) this.zoomAcc += Math.sign(e.deltaY);
      },
      { passive: true },
    );

    const forced = opts.touch === true || new URLSearchParams(location.search).get('touch') === '1';
    const coarse = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (opts.touch !== false && (forced || coarse)) this.enableTouch();
    else if (opts.touch !== false) {
      const first = () => {
        this.enableTouch();
        removeEventListener('touchstart', first);
      };
      addEventListener('touchstart', first, { passive: true });
      this.disposers.push(() => removeEventListener('touchstart', first));
    }
  }

  enableTouch(): void {
    if (!this.touch) this.touch = new TouchControls(document.body);
  }

  /** Move the selector with the transmission interlocks (no R or D change while rolling the other way). */
  selectGear(g: DriveInput['gear']): boolean {
    if (g === this.gear) return true;
    const v = telemetry.speed;
    if ((g === 'R' && v > 0.6) || (g === 'D' && v < -0.6)) {
      emitSimAny({ type: 'refused', what: 'gear' });
      return false;
    }
    this.gear = g;
    emitSimAny({ type: 'gearSelect', gear: g });
    return true;
  }

  poll(dt: number): SimInput {
    this.time += dt;
    const k = this.keys;
    const pressed = new Set<InputAction>();
    const held = new Set<InputAction>();
    const speed = Math.abs(telemetry.speed);

    // --- Keyboard edges --------------------------------------------------------
    for (const code of this.queue) {
      const a = KEY_ACTIONS[code];
      if (a) pressed.add(a);
      if (code === 'KeyR') this.selectGear(this.gear === 'R' ? 'D' : 'R');
      else if (code === 'KeyN') this.selectGear('N');
      else if (code === 'KeyG') this.selectGear('D');
      else if (code === 'PageUp') this.selectGear(this.gear === 'R' ? 'N' : 'D');
      else if (code === 'PageDown') this.selectGear(this.gear === 'D' ? 'N' : 'R');
    }
    this.queue.length = 0;
    for (const code of k) {
      const a = KEY_ACTIONS[code];
      if (a) held.add(a);
    }

    // --- Keyboard pedals ---------------------------------------------------------
    const up = k.has('KeyW') || k.has('ArrowUp');
    const down = k.has('KeyS') || k.has('ArrowDown');
    this.throttleKb = up ? Math.min(1, this.throttleKb + dt * 2.6) : Math.max(0, this.throttleKb - dt * 6);
    let emergency = false;
    if (down) {
      if (this.brakeKb < 0.32) this.brakeKb = 0.32;
      this.brakeKb = Math.min(1, this.brakeKb + dt * 0.75);
      if (this.shift) {
        this.brakeKb = 1;
        emergency = true;
      }
    } else this.brakeKb = Math.max(0, this.brakeKb - dt * 5);

    // --- Gamepad -------------------------------------------------------------------
    let padThrottle = 0;
    let padBrake = 0;
    let padSteerRaw = 0;
    let padActive = false;
    const pad = this.firstPad();
    if (pad) {
      const b = pad.buttons;
      const val = (i: number) => b[i]?.value ?? 0;
      const btn = (i: number) => b[i]?.pressed ?? false;
      padThrottle = val(7) > 0.03 ? val(7) : 0;
      padBrake = val(6) > 0.03 ? val(6) : 0;
      const lx = pad.axes[0] ?? 0;
      const dz = 0.12;
      const m = Math.max(0, (Math.abs(lx) - dz) / (1 - dz));
      padSteerRaw = Math.sign(lx) * Math.pow(m, 1.6);
      padActive = m > 0.02;
      for (const [iStr, a] of Object.entries(PAD_ACTIONS)) {
        const i = Number(iStr);
        const now = btn(i);
        if (now) held.add(a);
        if (now && !this.padPrev[i]) {
          pressed.add(a);
          if (a === 'gearUp') this.selectGear(this.gear === 'R' ? 'N' : 'D');
          if (a === 'gearDown') this.selectGear(this.gear === 'D' ? 'N' : 'R');
        }
        this.padPrev[i] = now;
      }
      // Right stick: look around.
      const rx = pad.axes[2] ?? 0;
      const ry = pad.axes[3] ?? 0;
      const lookOn = Math.hypot(rx, ry) > 0.2;
      if (lookOn) {
        this.lookYaw += (-rx * 1.9 - this.lookYaw) * Math.min(1, dt * 8);
        this.lookPitch += (-ry * 0.55 - this.lookPitch) * Math.min(1, dt * 8);
        this.releasedAt = this.time;
      }
      this.padLook = lookOn;
    }
    // --- Touch -----------------------------------------------------------------------
    const t = this.touch;
    if (t) {
      for (const a of t.pressed) pressed.add(a);
      t.pressed.length = 0;
      for (const a of t.held) held.add(a);
      if (t.gearRequest) {
        this.selectGear(t.gearRequest);
        t.gearRequest = null;
      }
      t.update(dt, this.gear);
    }

    // --- Steering ----------------------------------------------------------------------
    const kbDir = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const prevDevice = this.device;
    if (kbDir !== 0) this.device = 'keyboard';
    else if (padActive) this.device = 'gamepad';
    else if (t?.steering) this.device = 'touch';
    if (this.device === 'keyboard' && prevDevice !== 'keyboard') this.steerKb = this.steerOut;
    if (kbDir !== 0) {
      // Hand-over-hand: ~1.2 s centre to lock when parked, slower at speed; faster when unwinding.
      let rate = 0.85 / (1 + speed / 14);
      if (Math.sign(this.steerKb) === -kbDir && Math.abs(this.steerKb) > 0.02) rate *= 1.8;
      this.steerKb = Math.max(-1, Math.min(1, this.steerKb + kbDir * rate * dt));
    } else {
      // Castor return: gentle when parked, firm at speed.
      const ret = (0.9 + 1.4 * Math.min(1, speed / 8)) * dt;
      this.steerKb = Math.abs(this.steerKb) <= ret ? 0 : this.steerKb - Math.sign(this.steerKb) * ret;
    }
    const padRate = 3.0 * dt;
    this.steerPad += Math.max(-padRate, Math.min(padRate, padSteerRaw - this.steerPad));
    this.steerOut = this.device === 'keyboard' ? this.steerKb : this.device === 'gamepad' ? this.steerPad : (t?.steer ?? 0);

    // --- Free look return -------------------------------------------------------------------
    if (!this.drag && !this.padLook && this.time - this.releasedAt > 1.0) {
      const f = Math.exp(-dt * 2.6);
      this.lookYaw *= f;
      this.lookPitch *= f;
      if (Math.abs(this.lookYaw) < 1e-3) this.lookYaw = 0;
      if (Math.abs(this.lookPitch) < 1e-3) this.lookPitch = 0;
    }
    const zoom = this.zoomAcc;
    this.zoomAcc = 0;

    telemetry.gear = this.gear;
    return {
      player: true,
      throttle: Math.max(this.throttleKb, padThrottle, t?.throttle ?? 0),
      brake: Math.max(this.brakeKb, padBrake, t?.brake ?? 0),
      steer: this.steerOut,
      gear: this.gear,
      pressed,
      held,
      lookYaw: this.lookYaw,
      lookPitch: this.lookPitch,
      lookActive: this.drag !== null || this.padLook,
      zoom,
      device: this.device,
      emergency,
    };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.touch?.dispose();
    this.touch = null;
  }

  private firstPad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    for (const p of navigator.getGamepads()) if (p && p.connected) return p;
    return null;
  }
}
