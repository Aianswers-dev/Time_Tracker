// Runs the Scriptable widget script under Node with stubbed Scriptable APIs.
import { readFileSync } from 'node:fs';

const src = readFileSync(process.argv[2], 'utf8')
  .replace(
    "const API_URL = 'https://time-tracker.YOUR-SUBDOMAIN.workers.dev';",
    "const API_URL = 'https://app.test';",
  )
  .replace("const TOKEN = 'PASTE-YOUR-TOKEN-HERE';", "const TOKEN = 'tok';");

function makeRun(scenario, family) {
  const log = [];
  const files = new Map(
    scenario.cache
      ? [['/cache/time-tracker-widget-cache.json', JSON.stringify(scenario.cache)]]
      : [],
  );
  class Txt {
    constructor(t) {
      this.text = t;
      log.push(`text:${t}`);
    }
  }
  class Stack {
    addText(t) {
      return new Txt(t);
    }
    addSpacer() {}
    layoutVertically() {}
    addStack() {
      return new Stack();
    }
  }
  class ListWidget extends Stack {
    setPadding() {}
    presentMedium() {
      log.push('present');
      return Promise.resolve();
    }
  }
  class Color {
    constructor(h) {
      this.hex = h;
    }
    static dynamic(a) {
      return a;
    }
  }
  const Font = {
    systemFont: (n) => ({ n }),
    boldSystemFont: (n) => ({ n }),
    boldRoundedSystemFont: (n) => ({ n }),
  };
  class Request {
    constructor(url) {
      this.url = url;
    }
    async loadJSON() {
      if (this.headers?.Authorization !== 'Bearer tok') throw new Error('no auth header');
      if (scenario.fetchError) throw new Error('The Internet connection appears to be offline.');
      this.response = { statusCode: scenario.status ?? 200 };
      return scenario.body;
    }
  }
  const FileManager = {
    local: () => ({
      cacheDirectory: () => '/cache',
      joinPath: (a, b) => `${a}/${b}`,
      writeString: (p, s) => files.set(p, s),
      fileExists: (p) => files.has(p),
      readString: (p) => files.get(p),
    }),
  };
  class DateFormatter {
    useNoDateStyle() {}
    useShortTimeStyle() {}
    string(d) {
      return d.toISOString().slice(11, 16);
    }
  }
  const Script = { setWidget: () => log.push('setWidget'), complete: () => log.push('complete') };
  const config = { runsInWidget: family !== null, widgetFamily: family };
  const fn = new Function(
    'ListWidget',
    'Color',
    'Font',
    'Request',
    'FileManager',
    'DateFormatter',
    'Script',
    'config',
    `return (async () => { ${src} })();`,
  );
  return fn(ListWidget, Color, Font, Request, FileManager, DateFormatter, Script, config).then(
    () => log,
  );
}

const now = Date.now();
const open = {
  now: new Date(now).toISOString(),
  open: {
    segment: {
      id: 's',
      categoryId: 'c',
      startedAt: new Date(now - 72 * 60000).toISOString(),
      endedAt: null,
    },
    category: { id: 'c', name: 'Relaxing', color: '#d2230d', icon: 'sofa' },
    elapsedMin: 72,
  },
  today: {
    dayKey: '2026-10-06',
    totals: [
      { categoryId: 'w', name: 'Contract work', color: '#185fe2', icon: 'laptop', minutes: 310 },
      { categoryId: 'c', name: 'Relaxing', color: '#d2230d', icon: 'sofa', minutes: 95 },
    ],
    untrackedMin: 0,
  },
};
const idle = { ...open, open: null, today: { ...open.today, totals: [] } };
const cases = [
  ['open small', { body: open }, 'small'],
  ['open medium', { body: open }, 'medium'],
  ['open lock rect', { body: open }, 'accessoryRectangular'],
  ['open lock inline', { body: open }, 'accessoryInline'],
  ['open lock circular', { body: open }, 'accessoryCircular'],
  ['idle medium', { body: idle }, 'medium'],
  [
    'offline with cache',
    { fetchError: true, cache: { state: open, fetchedAt: new Date(now - 600000).toISOString() } },
    'medium',
  ],
  ['offline no cache', { fetchError: true }, 'small'],
  [
    '401',
    { status: 401, body: { error: { code: 'unauthorized', message: 'Missing or invalid token' } } },
    'small',
  ],
  ['in app', { body: open }, null],
];
let failed = 0;
for (const [name, scenario, family] of cases) {
  try {
    const log = await makeRun(scenario, family);
    console.log(
      `OK  ${name}: ${log
        .filter((l) => l.startsWith('text:'))
        .map((l) => l.slice(5))
        .join(' | ')} [${log.filter((l) => !l.startsWith('text:')).join(',')}]`,
    );
  } catch (e) {
    failed++;
    console.log(`ERR ${name}: ${e.stack}`);
  }
}
process.exit(failed ? 1 : 0);
