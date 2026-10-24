// Drive a route end to end on autopilot in headless Chromium and record it.
//
//   node tools/film/film.mjs --route M2 --dir 0 --out /tmp/film/m2 [options]
//
// Needs a dev server (pnpm dev, or SHOT_URL). The page runs with ?film=1: the
// sim only advances when this script asks, so slow software rendering still
// gives a smooth, correctly timed film.
//
// Options:
//   --every-m 15     cab frame every N metres driven...
//   --every-s 6      ...or every N sim seconds when (nearly) stopped
//   --chase 8        also a chase-camera frame every N cab frames (0 = never)
//   --fast           no frames at all: just drive and log (minutes, not hours)
//   --tour           don't drive: place the bus on the lane every --every-m metres
//                    (from --s to --to) and film it there (visual review only)
//   --hours 10 --traffic normal|light|off --s 0 (start distance)
//   --w 960 --h 540  frame size
//   --max 5400       give up after this many sim seconds
//
// Writes: report.json (autopilot problems, guide summary), track.jsonl (state
// every sim second), frames/*.png, cab.mp4 / chase.mp4 and sheets/*.png
// (captioned 3x3 contact sheets) when ffmpeg and python3+PIL are available.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i < 0 ? d : args[i + 1];
};
const flag = (k) => args.includes('--' + k);
const route = opt('route', 'M2');
const dir = opt('dir', '0');
const out = opt('out', `film_${route}_${dir}`);
const everyM = Number(opt('every-m', 15));
const everyS = Number(opt('every-s', 6));
const chaseEvery = Number(opt('chase', 8));
const fast = flag('fast');
const tour = flag('tour');
const tourTo = Number(opt('to', 1e9));
const maxT = Number(opt('max', 5400));
const W = Number(opt('w', 960));
const H = Number(opt('h', 540));
const base = process.env.SHOT_URL ?? 'http://localhost:5173/';
const query = new URLSearchParams({ route, dir, hours: opt('hours', '10'), traffic: opt('traffic', 'normal'), film: '1', s: opt('s', '0') });

mkdirSync(join(out, 'frames'), { recursive: true });
const trackFile = join(out, 'track.jsonl');
writeFileSync(trackFile, '');
const logs = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(600000);
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
await page.goto(base + '?' + query.toString());
await page.waitForFunction(() => window.__film?.ready, null, { timeout: 600000, polling: 1000 });
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
// Let background work (AI route tracks, traffic population) settle.
await page.waitForTimeout(fast ? 3000 : 8000);

let st = await page.evaluate(() => window.__film.state());
console.log('start', JSON.stringify(st));
let frame = 0;
let lastS = -1e9;
let lastT = -1e9;
let lastLog = -1;
const shot = async (name) => {
  await page.screenshot({ path: join(out, 'frames', name), timeout: 600000 });
};
const caption = [];
if (tour) {
  // Visual tour: the bus is placed on the lane every everyM metres, settles for a moment, and is filmed.
  const from = Number(opt('s', 0));
  const to = Math.min(st.length - 5, tourTo);
  for (let s = from; s <= to; s += everyM) {
    st = await page.evaluate((s) => {
      window.__film.place(s);
      return window.__film.advance(0.5);
    }, s);
    appendFileSync(trackFile, JSON.stringify(st) + '\n');
    const name = `cab_${String(frame).padStart(5, '0')}.png`;
    await shot(name);
    caption.push({ frame, file: name, ...st });
    if (chaseEvery > 0 && frame % chaseEvery === 0) {
      await page.evaluate(() => {
        window.__film.view('chase');
        window.__film.advance(0.3);
      });
      await shot(`chase_${String(frame / chaseEvery).padStart(5, '0')}.png`);
      await page.evaluate(() => window.__film.view('cab'));
    }
    frame++;
    if (frame % 10 === 0) {
      console.log(`frame ${frame} s=${st.s}/${Math.round(st.length)} [${((Date.now() - t0) / 1000).toFixed(0)} s wall]`);
      writeFileSync(join(out, 'frames.json'), JSON.stringify(caption, null, 0));
    }
  }
  st.finished = true;
}
while (!st.finished && st.t < maxT) {
  if (fast) {
    // Big steps, no rendering; state sampled every second.
    for (let k = 0; k < 20 && !st.finished; k++) {
      st = await page.evaluate(() => window.__film.advance(1, { draw: false }));
      appendFileSync(trackFile, JSON.stringify(st) + '\n');
    }
    if (Math.floor(st.t / 60) !== lastLog) {
      lastLog = Math.floor(st.t / 60);
      // Keep a recent report on disk in case the browser dies mid-run.
      const partial = await page.evaluate(() => window.__film.report());
      writeFileSync(join(out, 'report.partial.json'), JSON.stringify({ ...partial, final: st }, null, 1));
      console.log(`t=${st.t.toFixed(0)} s=${st.s}/${Math.round(st.length)} ${st.kmh} km/h ${st.phase} served ${st.served}/${st.total} missed ${st.missed} problems ${st.problems}`);
    }
    continue;
  }
  // Step in small chunks until we've gone far enough (or waited long enough) for the next frame.
  st = await page.evaluate(() => window.__film.advance(0.5, { draw: false }));
  if (Math.floor(st.t) !== lastLog) {
    lastLog = Math.floor(st.t);
    appendFileSync(trackFile, JSON.stringify(st) + '\n');
  }
  if (st.s - lastS < everyM && st.t - lastT < everyS) continue;
  lastS = st.s;
  lastT = st.t;
  await page.evaluate(() => window.__film.draw());
  const name = `cab_${String(frame).padStart(5, '0')}.png`;
  await shot(name);
  caption.push({ frame, file: name, ...st });
  if (chaseEvery > 0 && frame % chaseEvery === 0) {
    await page.evaluate(() => {
      window.__film.view('chase');
      window.__film.advance(0.6);
    });
    await shot(`chase_${String(frame / chaseEvery).padStart(5, '0')}.png`);
    await page.evaluate(() => {
      window.__film.view('cab');
      window.__film.draw();
    });
  }
  frame++;
  if (frame % 10 === 0) {
    const el = (Date.now() - t0) / 1000;
    console.log(`frame ${frame} t=${st.t.toFixed(0)} s=${st.s}/${Math.round(st.length)} ${st.kmh} km/h ${st.phase}/${st.why} served ${st.served}/${st.total} problems ${st.problems} [${el.toFixed(0)} s wall]`);
    writeFileSync(join(out, 'frames.json'), JSON.stringify(caption, null, 0));
  }
}
const report = await page.evaluate(() => window.__film.report());
report.final = st;
report.wallSeconds = Math.round((Date.now() - t0) / 1000);
report.console = logs.filter((l) => !l.includes('AudioContext')).slice(-200);
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 1));
writeFileSync(join(out, 'frames.json'), JSON.stringify(caption, null, 0));
await browser.close();
console.log(`done: t=${st.t} s=${st.s}/${Math.round(st.length)} served ${report.served}/${report.total} missed ${report.missed} problems ${report.problems.length} rescues ${report.rescues}`);

if (!fast && frame > 0) {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    for (const kind of ['cab', 'chase']) {
      if (!readdirSync(join(out, 'frames')).some((f) => f.startsWith(kind))) continue;
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', kind === 'cab' ? '6' : '3', '-i', join(out, 'frames', `${kind}_%05d.png`), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', join(out, `${kind}.mp4`)]);
    }
  } catch (e) {
    console.log('ffmpeg failed:', String(e).slice(0, 300));
  }
  if (existsSync(join(here, 'sheets.py'))) {
    try {
      execFileSync('python3', [join(here, 'sheets.py'), out], { stdio: 'inherit' });
    } catch (e) {
      console.log('contact sheets failed:', String(e).slice(0, 300));
    }
  }
}
