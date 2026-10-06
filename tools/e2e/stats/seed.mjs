// Seeding helpers that run inside the page (page.evaluate). The page's own
// timezone is the emulated one, so `new Date(y, m, d, h, min)` is local time.

export const CAT = {
  sleep: '00000000-0000-7000-8000-000000000001',
  relaxing: '00000000-0000-7000-8000-000000000002',
  housework: '00000000-0000-7000-8000-000000000003',
  casualWork: '00000000-0000-7000-8000-000000000004',
  contractWork: '00000000-0000-7000-8000-000000000005',
  uniStudy: '00000000-0000-7000-8000-000000000006',
  lifeAdmin: '00000000-0000-7000-8000-000000000007',
  travel: '00000000-0000-7000-8000-000000000008',
  socialising: '00000000-0000-7000-8000-000000000009',
  hobbies: '00000000-0000-7000-8000-00000000000a',
};

/** Wait until the app has seeded categories and settings. */
export async function waitForSeed(page) {
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('time-tracker');
        req.onsuccess = () => {
          const idb = req.result;
          if (!idb.objectStoreNames.contains('meta')) return resolve(false);
          const get = idb.transaction('meta').objectStore('meta').get('seededAt');
          get.onsuccess = () => resolve(Boolean(get.result));
          get.onerror = () => resolve(false);
        };
        req.onerror = () => resolve(false);
      }),
    null,
    { timeout: 15000 },
  );
}

/** Write segments straight into IndexedDB (replacing any), in chunks. */
export async function putSegments(page, segments) {
  const CHUNK = 2000;
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('time-tracker');
        req.onsuccess = () => {
          const tx = req.result.transaction('segments', 'readwrite');
          tx.objectStore('segments').clear();
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  for (let i = 0; i < segments.length; i += CHUNK) {
    const rows = segments.slice(i, i + CHUNK);
    await page.evaluate(
      (rows) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('time-tracker');
          req.onsuccess = () => {
            const tx = req.result.transaction('segments', 'readwrite');
            const store = tx.objectStore('segments');
            for (const r of rows) store.put(r);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
          };
        }),
      rows,
    );
  }
}

/**
 * Realistic days, generated in the page so local times use the emulated
 * timezone: sleep at night, uni or contract work on weekdays, hospitality
 * shifts Fri, Sat and Sun, evenings of relaxing (sometimes over the 3 h
 * budget), and some untracked gaps. Ends with an open segment at now.
 */
export function realisticSegments(page, days) {
  return page.evaluate(
    ({ days, CAT }) => {
      let seed = 42;
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };
      const pick = (a, b) => a + rnd() * (b - a);
      const now = Date.now();
      const today = new Date();
      const base = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
      const plan = []; // [startMs, categoryId, note]
      const at = (dayOffset, h, m = 0) => {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset);
        d.setHours(Math.floor(h), m + Math.round((h % 1) * 60), 0, 0);
        return d.getTime();
      };
      const add = (t, cat, note = null) => plan.push([t, cat, note]);
      const notes = [
        'Netflix, "The Bear" S3',
        'YouTube; then\nscrolling',
        'Gaming, "Hades II"',
        null,
        null,
        null,
      ];
      for (let i = 0; i <= days; i++) {
        const dow = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i).getDay(); // 0 Sun
        const weekend = dow === 0 || dow === 6;
        const wake = weekend ? pick(8, 9.5) : pick(6.5, 7.4);
        add(at(i, wake), CAT.housework, 'Breakfast');
        let t = wake + pick(0.4, 0.7);
        if (dow === 1 || dow === 3 || dow === 4) {
          add(at(i, t), CAT.travel);
          t += pick(0.4, 0.6);
          add(at(i, t), CAT.contractWork);
          t = pick(12.2, 12.8);
          add(at(i, t), CAT.housework, 'Lunch');
          t += pick(0.5, 0.8);
          if (rnd() < 0.25) {
            add(at(i, t), CAT.relaxing, 'Phone');
            t += pick(0.3, 0.8);
          }
          add(at(i, t), CAT.contractWork);
          t = pick(16.8, 17.6);
          add(at(i, t), CAT.travel);
          t += pick(0.4, 0.7);
        } else if (dow === 2 || dow === 5) {
          add(at(i, t), CAT.travel);
          t += pick(0.5, 0.7);
          add(at(i, t), CAT.uniStudy, 'Lectures');
          t = pick(12, 12.5);
          add(at(i, t), CAT.socialising, 'Lunch with friends');
          t += pick(0.6, 1);
          add(at(i, t), CAT.uniStudy, 'Assignment, part 2');
          t = pick(15, 15.6);
          if (rnd() < 0.5) {
            add(at(i, t), CAT.lifeAdmin, 'Bills, email');
            t += pick(0.3, 0.8);
          }
          add(at(i, t), CAT.travel);
          t += pick(0.4, 0.6);
        } else {
          add(at(i, t), CAT.relaxing, notes[Math.floor(rnd() * notes.length)]);
          t += pick(1, 2.5);
          add(at(i, t), CAT.hobbies, 'Guitar');
          t += pick(1, 2);
          add(at(i, t), CAT.housework, 'Groceries');
          t += pick(0.8, 1.4);
        }
        // Untracked gap on some days (deleted entries).
        if (rnd() < 0.18) {
          plan.push([at(i, t), null, null]);
          t += pick(0.4, 1.4);
        }
        const shift = dow === 5 || dow === 6 || (dow === 0 && rnd() < 0.5);
        if (shift) {
          const start = Math.max(t, 16.5);
          if (start > t) add(at(i, t), CAT.relaxing, notes[Math.floor(rnd() * notes.length)]);
          add(at(i, start), CAT.travel);
          add(at(i, start + 0.4), CAT.casualWork, 'Bar shift');
          t = start + pick(5.5, 6.5);
          add(at(i, t), CAT.travel);
          t += 0.4;
          add(at(i, t), CAT.relaxing, null);
          t += pick(0.4, 1.2);
        } else {
          add(at(i, t), CAT.housework, 'Cooking dinner');
          t += pick(0.7, 1.2);
          if (rnd() < 0.3) {
            add(at(i, t), CAT.socialising, 'Call with Mum');
            t += pick(0.4, 1.2);
          }
          if (rnd() < 0.25) {
            add(at(i, t), CAT.lifeAdmin, null);
            t += pick(0.3, 0.6);
          }
          add(at(i, t), CAT.relaxing, notes[Math.floor(rnd() * notes.length)]);
          t += pick(1.5, 4.6);
        }
        add(at(i, Math.max(t, 22)), CAT.sleep, null);
      }
      plan.sort((a, b) => a[0] - b[0]);
      const segments = [];
      for (let k = 0; k < plan.length; k++) {
        const [start, cat, note] = plan[k];
        if (start >= now) break;
        const next = plan[k + 1]?.[0];
        if (cat === null) continue; // a gap
        const end = next === undefined || next >= now ? null : next;
        if (end !== null && end - start < 60000) continue;
        const iso = new Date(start).toISOString();
        segments.push({
          id: crypto.randomUUID(),
          categoryId: cat,
          startedAt: iso,
          endedAt: end === null ? null : new Date(end).toISOString(),
          note,
          source: 'app',
          createdAt: iso,
          updatedAt: iso,
          deletedAt: null,
        });
        if (end === null) break;
      }
      return segments;
    },
    { days, CAT },
  );
}

/** 10,000 contiguous synthetic segments of 20 to 80 minutes ending at now (about a year). */
export function syntheticSegments(count = 10000) {
  const cats = Object.values(CAT);
  const lens = [];
  for (let i = 0; i < count; i++) lens.push((20 + ((i * 37) % 61)) * 60000);
  let t = Date.now() - lens.reduce((a, b) => a + b, 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    const iso = new Date(t).toISOString();
    out.push({
      id: `syn-${String(i).padStart(6, '0')}`,
      categoryId: cats[(i * 7) % cats.length],
      startedAt: iso,
      endedAt: last ? null : new Date(t + lens[i]).toISOString(),
      note: null,
      source: 'app',
      createdAt: iso,
      updatedAt: iso,
      deletedAt: null,
    });
    t += lens[i];
  }
  return out;
}
