// Main menu: route browser, details with mini map, bus/time choice, controls help.
import './menu.css';
import type { BusType, MapData, Route } from '../types';
import { BUS_ICONS, ICON_SEARCH, LOGO, TIME_ICONS } from './icons';
import { blitBase, fitView, routeBounds, strokeRoute, cityBase, type MapView } from './mapdraw';
import {
  GROUP_LABELS,
  GROUP_ORDER,
  OPERATOR_NAMES,
  busTypeForRoute,
  matchScore,
  routeEntries,
  stopDisplayName,
  type RouteEntry,
  type RouteGroup,
} from './routeMeta';
import { brighten, el, escapeHtml, fmtDistance, safeStorageGet, safeStorageSet } from './util';
import { TRAFFIC_LABELS, defaultTrafficLevel, saveTrafficLevel, type TrafficLevel } from './trafficLevel';
import { session } from './session';

export interface MenuChoice {
  route: Route;
  type: BusType;
  /** Local time of day to start at, 0..24. */
  hours: number;
  /** AI traffic density (already applied to the running Traffic via the session). */
  traffic: TrafficLevel;
}

export const TIME_CHOICES = [
  { key: 'dawn', label: 'Dawn', hours: 6, sub: '6:00' },
  { key: 'day', label: 'Day', hours: 10, sub: '10:00' },
  { key: 'dusk', label: 'Dusk', hours: 18, sub: '18:00' },
  { key: 'night', label: 'Night', hours: 21.5, sub: '21:30' },
] as const;

const CHIP_LABELS: Record<RouteGroup, string> = {
  metro: 'Metro',
  glider: 'CityGlider',
  buz: 'BUZ',
  loop: 'Loops',
  night: 'NightLink',
  south: 'South',
  east: 'East',
  north: 'North',
  west: 'West',
  other: 'Other',
};

const BUS_CHOICES: { type: BusType; label: string; sub: string }[] = [
  { type: 'rigid', label: 'Rigid', sub: '12.5 m' },
  { type: 'glider', label: 'CityGlider', sub: '12.5 m' },
  { type: 'metro', label: 'Metro', sub: '24.7 m' },
];

/** Keyboard reference. Inputs are owned by the driving subsystem. */
export const CONTROLS: { title: string; keys: [string, string[]][] }[] = [
  {
    title: 'Driving',
    keys: [
      ['Accelerate', ['W', '↑']],
      ['Brake', ['S', '↓']],
      ['Steer', ['A', 'D', '←', '→']],
      ['Reverse / drive', ['R']],
      ['Neutral · drive', ['N', 'G']],
      ['Park brake', ['F']],
    ],
  },
  {
    title: 'Bus',
    keys: [
      ['Doors open / close', ['O', 'Space']],
      ['Indicators left / right', ['Q', 'E']],
      ['Hazard lights', ['Z']],
      ['Horn', ['H']],
      ['Headlights', ['L']],
      ['Kneel', ['K']],
    ],
  },
  {
    title: 'View & game',
    keys: [
      ['Camera', ['C']],
      ['Look left / right / back', [',', '.', '/']],
      ['Route map', ['M']],
      ['Guidance chevrons', ['V']],
      ['Time of day', ['T']],
      ['Pause', ['P', 'Esc']],
      ['Reset bus', ['⌫']],
    ],
  },
];

const PREF_KEY = 'bbs.menu.v1';
interface Prefs {
  route?: string;
  dir?: number;
  type?: BusType;
  time?: string;
}

function badge(e: { id: string; color: string; textColor: string }, cls = ''): string {
  return `<span class="bbs-badge ${cls}" style="background:${e.color};color:${e.textColor}">${escapeHtml(e.id)}</span>`;
}

function groupTag(g: RouteGroup): string {
  switch (g) {
    case 'buz':
      return '<span class="bbs-tag buz">BUZ</span>';
    case 'metro':
      return '<span class="bbs-tag metro">Metro</span>';
    case 'glider':
      return '<span class="bbs-tag glider">CityGlider</span>';
    case 'night':
      return '<span class="bbs-tag night">NightLink</span>';
    case 'loop':
      return '<span class="bbs-tag">Free loop</span>';
    default:
      return '';
  }
}

function drawPreview(canvas: HTMLCanvasElement, data: MapData, entry: RouteEntry, route: Route): void {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(10, canvas.clientWidth);
  const h = Math.max(10, canvas.clientHeight);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const [x0, y0, x1, y1] = routeBounds(route);
  const v: MapView = fitView(x0, y0, x1, y1, w, h, 22);
  blitBase(ctx, data, v, w, h);
  const color = brighten(route.color, 0.25);
  // The other direction, faint.
  for (const d of entry.dirs) if (d !== route) strokeRoute(ctx, d, v, 'rgba(255,255,255,0.22)', 2.5);
  strokeRoute(ctx, route, v, 'rgba(0,0,0,0.6)', 7);
  strokeRoute(ctx, route, v, color, 4);
  // Direction arrows every ~1/6 of the route.
  ctx.fillStyle = '#fff';
  const p = route.pts;
  const c = route.cum;
  for (let k = 1; k < 6; k++) {
    const s = (route.length * k) / 6;
    let i = 0;
    while (i < c.length - 2 && c[i + 1] < s) i++;
    const ax = (p[2 * i] - v.x0) * v.scale;
    const ay = (v.y0 - p[2 * i + 1]) * v.scale;
    const bx = (p[2 * i + 2] - v.x0) * v.scale;
    const by = (v.y0 - p[2 * i + 3]) * v.scale;
    const t = (s - c[i]) / Math.max(1e-3, c[i + 1] - c[i]);
    const mx = ax + (bx - ax) * t;
    const my = ay + (by - ay) * t;
    const ang = Math.atan2(by - ay, bx - ax);
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(5, 0);
    ctx.lineTo(-3.5, -4);
    ctx.lineTo(-1.5, 0);
    ctx.lineTo(-3.5, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  // Stops.
  for (const st of route.stops) {
    const s = data.stops[st.stop];
    const X = (s.x - v.x0) * v.scale;
    const Y = (v.y0 - s.y) * v.scale;
    ctx.beginPath();
    ctx.arc(X, Y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#0b1f3a';
    ctx.stroke();
  }
  // Start and end markers.
  const mark = (x: number, y: number, fill: string) => {
    const X = (x - v.x0) * v.scale;
    const Y = (v.y0 - y) * v.scale;
    ctx.beginPath();
    ctx.arc(X, Y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#0b1f3a';
    ctx.fill();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = fill;
    ctx.stroke();
  };
  const n = p.length;
  mark(p[n - 2], p[n - 1], '#ff6b6b');
  const first = route.stops[0] ? data.stops[route.stops[0].stop] : { x: p[0], y: p[1] };
  mark(first.x, first.y, '#8dc63f');
}

export function showMenu(data: MapData): Promise<MenuChoice> {
  return new Promise((resolve) => {
    const entries = routeEntries(data);
    const prefs: Prefs = (() => {
      try {
        return JSON.parse(safeStorageGet(PREF_KEY) ?? '{}') as Prefs;
      } catch {
        return {};
      }
    })();
    let sel: RouteEntry = entries.find((e) => e.id === (prefs.route ?? '61')) ?? entries[0];
    let dirIdx = Math.min(sel.dirs.length - 1, Math.max(0, sel.dirs.findIndex((d) => d.dir === (prefs.dir ?? 0))));
    let typeOverride: BusType | null = prefs.route === sel.id && prefs.type ? prefs.type : null;
    let timeKey: string = prefs.time ?? 'day';
    let group: RouteGroup | 'all' = 'all';
    let traffic: TrafficLevel = defaultTrafficLevel();
    let trafficTouched = false;
    let query = '';
    let visible: RouteEntry[] = [];

    const root = el('div', 'bbs-menu');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Choose a route');
    const nStops = new Set(data.routes.flatMap((r) => r.stops.map((s) => s.stop))).size;
    root.innerHTML = `
      <header class="bbs-top">
        <div class="bbs-brand">${LOGO}<div><h1>Brisbane <span>Bus</span> Simulator</h1>
        <p>Drive real TransLink routes through the CBD and inner suburbs · ${entries.length} routes · ${nStops.toLocaleString()} stops</p></div></div>
        <div class="bbs-spacer"></div>
        <div class="bbs-traffic" role="radiogroup" aria-label="AI traffic" title="AI traffic"><span>Traffic</span>${(['off', 'light', 'normal'] as TrafficLevel[])
          .map((l) => `<button role="radio" data-traffic="${l}">${TRAFFIC_LABELS[l]}</button>`)
          .join('')}</div>
        <button class="bbs-ghost" data-act="controls" aria-haspopup="dialog">Controls <kbd>?</kbd></button>
      </header>
      <main class="bbs-body">
        <section class="bbs-panel bbs-browser" aria-label="Routes">
          <label class="bbs-search">${ICON_SEARCH}<input type="search" autocomplete="off" spellcheck="false" placeholder="Route, suburb or stop" aria-label="Search routes"/><span class="bbs-count"></span></label>
          <div class="bbs-chips" role="tablist"></div>
          <div class="bbs-list" role="listbox" tabindex="-1"></div>
        </section>
        <section class="bbs-panel bbs-detail" aria-label="Route details"></section>
      </main>
      <div class="bbs-modal" hidden><div class="bbs-panel" role="dialog" aria-label="Controls"></div></div>`;
    document.body.appendChild(root);

    const input = root.querySelector<HTMLInputElement>('.bbs-search input')!;
    const count = root.querySelector<HTMLSpanElement>('.bbs-count')!;
    const chips = root.querySelector<HTMLDivElement>('.bbs-chips')!;
    const list = root.querySelector<HTMLDivElement>('.bbs-list')!;
    const detail = root.querySelector<HTMLElement>('.bbs-detail')!;
    const modal = root.querySelector<HTMLDivElement>('.bbs-modal')!;

    // Controls help.
    modal.firstElementChild!.innerHTML = `<h3>Controls <button class="bbs-ghost" data-act="close">Close <kbd>Esc</kbd></button></h3>
      <div class="bbs-keys">${CONTROLS.map(
        (g) => `<h4>${g.title}</h4>${g.keys.map(([what, ks]) => `<div class="bbs-key"><span>${what}</span><span>${ks.map((k) => `<kbd>${k}</kbd>`).join('')}</span></div>`).join('')}`,
      ).join('')}</div>
      <div class="bbs-note"><b>Gamepad:</b> RT accelerate, LT brake, left stick steer, right stick look · A doors · B park brake · X horn · Y camera · LB / RB indicators · D-pad ↑↓ gears, ← lights · View map · Menu pause.<br>
      <b>Touch:</b> on-screen pedals and steering appear on phones and tablets.<br>
      <b>Your shift:</b> pull up with the front of the bus at each stop flag, stop, and open the doors (O) to serve it. Keep to the timetable — the console shows how early or late you are. Brisbane drives on the left.</div>`;
    const openModal = (open: boolean) => {
      modal.hidden = !open;
      if (open) modal.querySelector<HTMLButtonElement>('[data-act="close"]')?.focus();
    };
    modal.addEventListener('click', (e) => {
      if (e.target === modal || (e.target as HTMLElement).closest('[data-act="close"]')) openModal(false);
    });
    root.querySelector('[data-act="controls"]')!.addEventListener('click', () => openModal(true));
    const trafficBox = root.querySelector<HTMLDivElement>('.bbs-traffic')!;
    const syncTraffic = () =>
      trafficBox.querySelectorAll<HTMLButtonElement>('[data-traffic]').forEach((b) => {
        const on = b.dataset.traffic === traffic;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      });
    trafficBox.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-traffic]');
      if (!b) return;
      traffic = b.dataset.traffic as TrafficLevel;
      trafficTouched = true;
      syncTraffic();
    });
    syncTraffic();

    // Category chips (only groups that exist).
    const present = new Set(entries.map((e) => e.group));
    const groups: (RouteGroup | 'all')[] = ['all', ...GROUP_ORDER.filter((g) => present.has(g))];
    const dot: Partial<Record<RouteGroup, string>> = { metro: '#e463a4', glider: '#6dd0f6', buz: '#f7c948', loop: '#d20000', night: '#7d79e6' };
    chips.innerHTML = groups
      .map(
        (g) =>
          `<button class="bbs-chip" role="tab" data-g="${g}">${g !== 'all' && dot[g] ? `<i style="background:${dot[g]}"></i>` : ''}${g === 'all' ? 'All' : CHIP_LABELS[g]}</button>`,
      )
      .join('');
    const syncChips = () => chips.querySelectorAll<HTMLButtonElement>('.bbs-chip').forEach((b) => b.classList.toggle('on', b.dataset.g === group));
    chips.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.bbs-chip');
      if (!b) return;
      group = b.dataset.g as RouteGroup | 'all';
      syncChips();
      renderList(true);
    });

    const renderList = (scrollTop = false) => {
      const q = query.trim().toLowerCase();
      const scored = entries
        .filter((e) => group === 'all' || e.group === group)
        .map((e) => ({ e, sc: matchScore(e, q) }))
        .filter((x) => x.sc > 0);
      if (q) scored.sort((a, b) => b.sc - a.sc);
      visible = scored.map((x) => x.e);
      count.textContent = q || group !== 'all' ? `${visible.length}` : '';
      const item = (e: RouteEntry) => {
        const stops = Math.max(...e.dirs.map((d) => d.stops.length));
        const meta = [e.tag, e.dirs.length > 1 ? 'both ways' : 'one way', `${stops} stops`, fmtDistance(Math.max(...e.dirs.map((d) => d.length)))].filter(Boolean).join(' · ');
        return `<button class="bbs-item${e === sel ? ' sel' : ''}" role="option" aria-selected="${e === sel}" data-id="${escapeHtml(e.id)}">${badge(e)}<span class="bbs-txt"><span class="bbs-name">${escapeHtml(e.name)}</span><span class="bbs-meta">${escapeHtml(meta)}</span></span></button>`;
      };
      let html = '';
      if (!visible.length) html = `<div class="bbs-empty">No routes match “${escapeHtml(query)}”.<br>Try a route number, suburb or street.</div>`;
      else if (!q && group === 'all') {
        for (const g of GROUP_ORDER) {
          const items = visible.filter((e) => e.group === g);
          if (!items.length) continue;
          html += `<div class="bbs-group">${GROUP_LABELS[g]}</div>${items.map(item).join('')}`;
        }
      } else html = visible.map(item).join('');
      list.innerHTML = html;
      if (scrollTop) list.scrollTop = 0;
    };

    const scrollSelIntoView = () => {
      const b = list.querySelector<HTMLElement>('.bbs-item.sel');
      if (!b) return;
      const lt = list.getBoundingClientRect();
      const bt = b.getBoundingClientRect();
      if (bt.top < lt.top + 36 || bt.bottom > lt.bottom) list.scrollTop += bt.top - lt.top - lt.height / 2 + bt.height / 2;
    };

    const currentType = (): BusType => typeOverride ?? busTypeForRoute(sel.dirs[dirIdx]);

    let previewCanvas: HTMLCanvasElement | null = null;
    const renderDetail = () => {
      const r = sel.dirs[dirIdx];
      const def = busTypeForRoute(r);
      const type = currentType();
      const first = r.stops[0] ? stopDisplayName(data.stops[r.stops[0].stop].name) : '—';
      const last = r.stops.length ? stopDisplayName(data.stops[r.stops[r.stops.length - 1].stop].name) : '—';
      const runTime = r.stops.length ? r.stops[r.stops.length - 1].t : 0;
      const op = OPERATOR_NAMES[r.operator] ?? r.operator;
      detail.innerHTML = `<div class="bbs-dscroll">
        <div class="bbs-dhead">${badge(sel, 'lg')}<div><h2>${escapeHtml(sel.name)}</h2>
          <div class="bbs-op">${groupTag(sel.group)}${sel.tag ? `<span class="bbs-tag">${escapeHtml(sel.tag)}</span>` : ''}<span>${escapeHtml(op)}</span><span>· ${sel.trips.toLocaleString()} trips a week</span></div></div></div>
        <div class="bbs-dirs" role="radiogroup" aria-label="Direction">${sel.dirs
          .map(
            (d, i) =>
              `<button class="bbs-dir${i === dirIdx ? ' on' : ''}" role="radio" aria-checked="${i === dirIdx}" data-dir="${i}"><div class="bbs-to">${sel.dirs.length > 1 ? `Direction ${i + 1} · to` : 'To'}</div><div class="bbs-hs">${escapeHtml(d.headsign)}</div></button>`,
          )
          .join('')}</div>
        <div class="bbs-preview"><canvas aria-label="Route map preview"></canvas>
          <div class="bbs-pstats"><span><b>${fmtDistance(r.length)}</b> on map</span><span><b>${r.stops.length}</b> stops</span>${runTime ? `<span><b>${Math.round(runTime / 60)}</b> min timetabled</span>` : ''}</div>
          <div class="bbs-legend"><span><b style="background:#8dc63f"></b>First stop</span><span><b style="background:#ff6b6b"></b>End</span><span><b style="background:#fff"></b>Stops</span></div></div>
        <div class="bbs-ends" title="${escapeHtml(first)} → ${escapeHtml(last)}"><i></i><span>${escapeHtml(first)}</span><em>→</em><i class="end"></i><span>${escapeHtml(last)}</span></div>
        <div class="bbs-opts">
          <div class="bbs-opt"><label>Bus</label><div class="bbs-seg bus" role="radiogroup" aria-label="Bus type">${BUS_CHOICES.map(
            (b) =>
              `<button role="radio" data-type="${b.type}" aria-checked="${b.type === type}" class="${b.type === type ? 'on' : ''}" title="${b.type === def ? 'Default for this route' : ''}">${BUS_ICONS[b.type]}<span>${b.label}<small>${b.sub}</small></span>${b.type === def ? '<i class="bbs-def"></i>' : ''}</button>`,
          ).join('')}</div></div>
          <div class="bbs-opt"><label>Time of day</label><div class="bbs-seg time" role="radiogroup" aria-label="Time of day">${TIME_CHOICES.map(
            (t) =>
              `<button role="radio" data-time="${t.key}" aria-checked="${t.key === timeKey}" class="${t.key === timeKey ? 'on' : ''}">${TIME_ICONS[t.key]}<span>${t.label}<small>${t.sub}</small></span></button>`,
          ).join('')}</div></div>
        </div></div>
        <div class="bbs-foot"><button class="bbs-start" data-act="start">Start shift on ${badge(sel)} <span class="bbs-go">›</span></button>
        <div class="bbs-hint">Enter to start · ↑ ↓ browse · ← → direction · / search</div></div>`;
      previewCanvas = detail.querySelector('canvas');
      requestAnimationFrame(() => previewCanvas && drawPreview(previewCanvas, data, sel, r));
    };

    detail.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const dirB = t.closest<HTMLButtonElement>('[data-dir]');
      if (dirB) {
        dirIdx = Number(dirB.dataset.dir);
        renderDetail();
        return;
      }
      const typeB = t.closest<HTMLButtonElement>('[data-type]');
      if (typeB) {
        const ty = typeB.dataset.type as BusType;
        typeOverride = ty === busTypeForRoute(sel.dirs[dirIdx]) ? null : ty;
        renderDetail();
        return;
      }
      const timeB = t.closest<HTMLButtonElement>('[data-time]');
      if (timeB) {
        timeKey = timeB.dataset.time ?? 'day';
        renderDetail();
        return;
      }
      if (t.closest('[data-act="start"]')) start();
    });

    const select = (e: RouteEntry, keepDir = false) => {
      if (e !== sel) {
        sel = e;
        typeOverride = null;
        if (!keepDir) dirIdx = 0;
      }
      list.querySelectorAll<HTMLElement>('.bbs-item').forEach((b) => {
        const on = b.dataset.id === e.id;
        b.classList.toggle('sel', on);
        b.setAttribute('aria-selected', String(on));
      });
      renderDetail();
    };

    list.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.bbs-item');
      if (!b) return;
      const entry = entries.find((x) => x.id === b.dataset.id);
      if (entry) select(entry);
    });
    list.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.bbs-item')) start();
    });

    input.addEventListener('input', () => {
      query = input.value;
      renderList(true);
      const q = query.trim().toLowerCase();
      if (q && visible.length && (visible[0].id.toLowerCase() === q || !visible.includes(sel))) select(visible[0]);
    });

    const move = (d: number) => {
      if (!visible.length) return;
      let i = visible.indexOf(sel);
      i = i < 0 ? 0 : Math.max(0, Math.min(visible.length - 1, i + d));
      select(visible[i]);
      scrollSelIntoView();
    };

    let done = false;
    const onKey = (e: KeyboardEvent) => {
      if (done) return;
      if (!modal.hidden) {
        if (e.key === 'Escape' || e.key === '?') {
          openModal(false);
          e.preventDefault();
        }
        return;
      }
      const inInput = document.activeElement === input;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        move(e.key === 'ArrowDown' ? 1 : -1);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        const t = e.target as HTMLElement;
        if (!inInput && t.closest('button')) return; // let buttons handle Enter
        start();
        e.preventDefault();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (inInput || sel.dirs.length < 2) return;
        dirIdx = e.key === 'ArrowLeft' ? 0 : 1;
        renderDetail();
        e.preventDefault();
      } else if (e.key === '/' && !inInput) {
        input.focus();
        e.preventDefault();
      } else if (e.key === '?' && !inInput) {
        openModal(true);
        e.preventDefault();
      } else if (e.key === 'Escape' && inInput) {
        input.value = '';
        query = '';
        renderList(true);
        input.blur();
      } else if (!inInput && e.key.length === 1 && /[\w ]/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        input.focus();
      }
    };
    addEventListener('keydown', onKey, true);

    let resizeRaf = 0;
    const onResize = () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => previewCanvas && drawPreview(previewCanvas, data, sel, sel.dirs[dirIdx]));
    };
    addEventListener('resize', onResize);

    const start = () => {
      if (done) return;
      done = true;
      const route = sel.dirs[dirIdx];
      const time = TIME_CHOICES.find((t) => t.key === timeKey) ?? TIME_CHOICES[1];
      safeStorageSet(PREF_KEY, JSON.stringify({ route: sel.id, dir: route.dir, type: typeOverride ?? undefined, time: timeKey } satisfies Prefs));
      removeEventListener('keydown', onKey, true);
      removeEventListener('resize', onResize);
      if (trafficTouched) saveTrafficLevel(traffic);
      session.trafficLevel = traffic;
      root.classList.add('leaving');
      setTimeout(() => root.remove(), 480);
      resolve({ route, type: currentType(), hours: time.hours, traffic });
    };

    syncChips();
    renderList();
    renderDetail();
    requestAnimationFrame(() => {
      scrollSelIntoView();
      if (matchMedia('(pointer: fine)').matches) input.focus({ preventScroll: true });
    });
    // Warm the base map so the preview is instant (drawn once, ~50 ms).
    setTimeout(() => {
      cityBase(data);
      if (previewCanvas) drawPreview(previewCanvas, data, sel, sel.dirs[dirIdx]);
    }, 0);
  });
}
