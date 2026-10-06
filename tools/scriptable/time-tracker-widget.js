// Time Tracker widget for Scriptable (https://scriptable.app).
//
// Shows what you're tracking right now, for how long, and today's top
// categories. Works as a small or medium Home Screen widget and as a
// rectangular, inline or circular Lock Screen widget.
//
// Setup: paste your app URL and token below, run the script once in
// Scriptable to check it, then add a Scriptable widget and pick this script.
// Full steps: docs/06-ios.md in the Time Tracker repo.

// ===== Your settings =====================================================
const API_URL = 'https://time-tracker.YOUR-SUBDOMAIN.workers.dev';
const TOKEN = 'PASTE-YOUR-TOKEN-HERE';
// ==========================================================================

const CACHE_FILE = 'time-tracker-widget-cache.json';
const REFRESH_MINUTES = 5;

async function fetchState() {
  const req = new Request(`${API_URL.replace(/\/+$/, '')}/api/state`);
  req.headers = { Authorization: `Bearer ${TOKEN}` };
  req.timeoutInterval = 15;
  const body = await req.loadJSON();
  const status = req.response && req.response.statusCode;
  if (status !== 200) {
    const message = body && body.error ? body.error.message : `HTTP ${status}`;
    const err = new Error(message);
    err.status = status;
    throw err;
  }
  return body;
}

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.cacheDirectory(), CACHE_FILE);
}

function saveCache(state) {
  try {
    FileManager.local().writeString(cachePath(), JSON.stringify(state));
  } catch {
    // A failed cache write only loses the offline fallback.
  }
}

function loadCache() {
  try {
    const fm = FileManager.local();
    const path = cachePath();
    if (!fm.fileExists(path)) return null;
    return JSON.parse(fm.readString(path));
  } catch {
    return null;
  }
}

// Elapsed minutes now, not when the server answered: the widget may render a
// cached state long after it was fetched.
function elapsedMinutesNow(state) {
  if (!state.open) return 0;
  const started = new Date(state.open.segment.startedAt).getTime();
  return Math.max(0, Math.floor((Date.now() - started) / 60000));
}

function formatMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatTime(date) {
  const df = new DateFormatter();
  df.useNoDateStyle();
  df.useShortTimeStyle();
  return df.string(date);
}

// White or near-black, whichever reads better on the category colour.
function textColorFor(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum =
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255);
  const contrastWhite = 1.05 / (lum + 0.05);
  const contrastDark = (lum + 0.05) / 0.0546;
  return contrastWhite >= contrastDark ? new Color('#ffffff') : new Color('#0b0d12');
}

function todayMinutesFor(state, categoryId) {
  const row = state.today.totals.find((t) => t.categoryId === categoryId);
  return row ? row.minutes : 0;
}

function addFooter(widget, fetchedAt, offline, color) {
  widget.addSpacer();
  const footer = widget.addText(`${offline ? 'Offline · ' : ''}as of ${formatTime(fetchedAt)}`);
  footer.font = Font.systemFont(10);
  footer.textColor = color;
  footer.textOpacity = 0.7;
}

function buildHomeWidget(state, family, fetchedAt, offline) {
  const widget = new ListWidget();
  widget.url = API_URL;
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60000);
  widget.setPadding(14, 14, 12, 14);

  if (!state.open) {
    widget.backgroundColor = Color.dynamic(new Color('#ffffff'), new Color('#151922'));
    const title = widget.addText('Not tracking');
    title.font = Font.boldSystemFont(16);
    const hint = widget.addText('Open Time Tracker and pick what you are doing.');
    hint.font = Font.systemFont(12);
    hint.textOpacity = 0.7;
    addFooter(
      widget,
      fetchedAt,
      offline,
      Color.dynamic(new Color('#12151c'), new Color('#eceff5')),
    );
    return widget;
  }

  const cat = state.open.category;
  const fg = textColorFor(cat.color);
  widget.backgroundColor = new Color(cat.color);

  const name = widget.addText(cat.name);
  name.font = Font.boldSystemFont(family === 'small' ? 16 : 18);
  name.textColor = fg;
  name.lineLimit = 1;
  name.minimumScaleFactor = 0.6;

  const elapsed = widget.addText(formatMinutes(elapsedMinutesNow(state)));
  elapsed.font = Font.boldRoundedSystemFont(family === 'small' ? 30 : 34);
  elapsed.textColor = fg;

  const today = widget.addText(`${formatMinutes(todayMinutesFor(state, cat.id))} today`);
  today.font = Font.systemFont(12);
  today.textColor = fg;
  today.textOpacity = 0.85;

  if (family !== 'small') {
    widget.addSpacer(6);
    for (const row of state.today.totals.slice(0, 3)) {
      const line = widget.addText(`${row.name} · ${formatMinutes(row.minutes)}`);
      line.font = Font.systemFont(12);
      line.textColor = fg;
      line.lineLimit = 1;
    }
  }

  addFooter(widget, fetchedAt, offline, fg);
  return widget;
}

function buildLockWidget(state, family, offline) {
  const widget = new ListWidget();
  widget.url = API_URL;
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60000);
  const name = state.open ? state.open.category.name : 'Not tracking';
  const elapsed = state.open ? formatMinutes(elapsedMinutesNow(state)) : '';
  const mark = offline ? ' ·' : '';

  if (family === 'accessoryInline') {
    widget.addText(state.open ? `${name} ${elapsed}${mark}` : name);
    return widget;
  }
  if (family === 'accessoryCircular') {
    const stack = widget.addStack();
    stack.layoutVertically();
    const top = stack.addText(state.open ? elapsed : '–');
    top.font = Font.boldSystemFont(14);
    top.minimumScaleFactor = 0.5;
    const bottom = stack.addText(name.slice(0, 6));
    bottom.font = Font.systemFont(9);
    return widget;
  }
  const title = widget.addText(name);
  title.font = Font.boldSystemFont(15);
  title.lineLimit = 1;
  if (state.open) {
    const line = widget.addText(
      `${elapsed} · ${formatMinutes(todayMinutesFor(state, state.open.category.id))} today${mark}`,
    );
    line.font = Font.systemFont(13);
  }
  return widget;
}

function buildErrorWidget(message) {
  const widget = new ListWidget();
  widget.url = API_URL;
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60000);
  const title = widget.addText('Time Tracker');
  title.font = Font.boldSystemFont(14);
  const body = widget.addText(message);
  body.font = Font.systemFont(11);
  body.textOpacity = 0.8;
  return widget;
}

function errorMessage(error) {
  if (TOKEN.startsWith('PASTE')) return 'Set API_URL and TOKEN at the top of the script.';
  if (error && error.status === 401) return 'Token rejected. Check TOKEN at the top of the script.';
  return `Can't reach the app: ${error && error.message ? error.message : error}`;
}

async function main() {
  const family = config.widgetFamily || 'medium';
  let state = null;
  let offline = false;
  let fetchedAt = new Date();
  let error = null;

  try {
    state = await fetchState();
    saveCache({ state, fetchedAt: fetchedAt.toISOString() });
  } catch (e) {
    error = e;
    const cached = loadCache();
    if (cached) {
      state = cached.state;
      fetchedAt = new Date(cached.fetchedAt);
      offline = true;
    }
  }

  let widget;
  if (!state) {
    widget = buildErrorWidget(errorMessage(error));
  } else if (family.startsWith('accessory')) {
    widget = buildLockWidget(state, family, offline);
  } else {
    widget = buildHomeWidget(state, family, fetchedAt, offline);
  }

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentMedium();
  }
  Script.complete();
}

await main();
