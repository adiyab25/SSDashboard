import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Spec 0004, AC-21: `ssd_operating_day()` on the real Cairo daylight saving transitions, checked
// against Node `Intl`. Two years are always checked: 2026, the fixed table the spec pins, and the
// release year (the current UTC year), whose two transitions are computed from the rule (summer
// time starts at 00:00 on the last Friday of April and ends at 24:00 on the last Thursday of
// October), never hard coded. `pnpm check:timezone` runs this file as the release gate.

const ZONE = 'Africa/Cairo';
const HOUR = 3_600_000;

/** Years under test: 2026 always, plus the release year (the current UTC year) when it differs. */
const YEARS = [...new Set([2026, new Date().getUTCFullYear()])];

const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The Cairo wall clock of an instant according to Node's time zone data. */
function wallClock(ms: number): { date: string; offsetHours: number } {
  const p = Object.fromEntries(
    partsFormat.formatToParts(new Date(ms)).map((part) => [part.type, part.value]),
  );
  const wallAsUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    offsetHours: (wallAsUtc - Math.floor(ms / 1000) * 1000) / HOUR,
  };
}

/** The last given weekday (0 Sunday to 6 Saturday) of a month, as the UTC midnight of that date. */
function lastWeekday(year: number, monthIndex: number, weekday: number): number {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return last.getTime() - ((last.getUTCDay() - weekday + 7) % 7) * 24 * HOUR;
}

/** The two transitions of a year from the rule: start at 00:00 (UTC+2), end at 24:00 (UTC+3). */
function ruleTransitions(year: number): { start: number; end: number } {
  return {
    start: lastWeekday(year, 3, 5) - 2 * HOUR, // last Friday of April, 00:00 at UTC+2
    end: lastWeekday(year, 9, 4) + 24 * HOUR - 3 * HOUR, // last Thursday of October, 24:00 at UTC+3
  };
}

/** Every hour of a UTC year where Node's Cairo offset differs from the hour before. */
function intlOffsetChanges(year: number): number[] {
  const changes: number[] = [];
  const first = Date.UTC(year, 0, 1);
  const last = Date.UTC(year + 1, 0, 1);
  for (let ms = first + HOUR; ms < last; ms += HOUR) {
    if (wallClock(ms).offsetHours !== wallClock(ms - HOUR).offsetHours) changes.push(ms);
  }
  return changes;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

/** The fixed 2026 table of the spec: instant (UTC) and the expected operating day. */
const TABLE_2026: ReadonlyArray<readonly [string, string]> = [
  ['2026-04-23T21:59:59Z', '2026-04-23'],
  ['2026-04-23T22:00:00Z', '2026-04-24'],
  ['2026-04-24T20:59:59Z', '2026-04-24'],
  ['2026-04-24T21:00:00Z', '2026-04-25'],
  ['2026-10-28T21:00:00Z', '2026-10-29'],
  ['2026-10-29T21:59:59Z', '2026-10-29'],
  ['2026-10-29T22:00:00Z', '2026-10-30'],
];

describe('operating day across Cairo daylight saving (AC-21)', () => {
  let name: string;
  let owner: pg.Client;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    await runMigrations(db.url);
    owner = new pg.Client({ connectionString: db.url });
    await owner.connect();
    // Pin all three inputs of the function so nothing outside this test can move the answer.
    await owner.query("SELECT set_config('ssd.tenant_id', (SELECT id::text FROM install), false)");
    await owner.query(
      `INSERT INTO settings (key, value) VALUES ('timezone', to_jsonb($1::text)), ('operating_day_cutoff_hour', to_jsonb(0))
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = excluded.value`,
      [ZONE],
    );
  });

  afterAll(async () => {
    await owner?.end();
    await dropScratchDatabase(name);
  });

  /** `ssd_operating_day` of an instant, as `YYYY-MM-DD`. */
  async function dayOf(instant: string): Promise<string> {
    const { rows } = await owner.query<{ day: string }>(
      "SELECT to_char(ssd_operating_day($1::timestamptz), 'YYYY-MM-DD') AS day",
      [instant],
    );
    return rows[0]?.day ?? '';
  }

  /** PostgreSQL's Cairo offset changes in a UTC year, hour stepped, as epoch milliseconds. */
  async function pgOffsetChanges(year: number): Promise<number[]> {
    const { rows } = await owner.query<{ at: string }>(
      `WITH hours AS (
         SELECT h, extract(epoch FROM (h AT TIME ZONE $1) - (h AT TIME ZONE 'UTC')) AS off,
                lag(extract(epoch FROM (h AT TIME ZONE $1) - (h AT TIME ZONE 'UTC'))) OVER (ORDER BY h) AS prev
         FROM generate_series(make_timestamptz($2::int, 1, 1, 0, 0, 0, 'UTC'),
                              make_timestamptz($2::int + 1, 1, 1, 0, 0, 0, 'UTC'), interval '1 hour') AS h)
       SELECT (extract(epoch FROM h) * 1000)::bigint::text AS at FROM hours WHERE prev IS NOT NULL AND off <> prev ORDER BY h`,
      [ZONE, year],
    );
    return rows.map((row) => Number(row.at));
  }

  /** Hourly instants per operating day over a window, counted by PostgreSQL's answer. */
  async function hoursPerDay(from: number, to: number): Promise<Map<string, number>> {
    const { rows } = await owner.query<{ day: string; hours: string }>(
      `SELECT to_char(ssd_operating_day(h), 'YYYY-MM-DD') AS day, count(*)::text AS hours
       FROM generate_series($1::timestamptz, $2::timestamptz, interval '1 hour') AS h GROUP BY 1`,
      [iso(from), iso(to)],
    );
    return new Map(rows.map((row) => [row.day, Number(row.hours)]));
  }

  it('answers the fixed 2026 table', async () => {
    for (const [instant, day] of TABLE_2026) {
      expect(await dayOf(instant), `at ${instant}`).toBe(day);
      expect(wallClock(Date.parse(instant)).date, `Intl at ${instant}`).toBe(day);
    }
  });

  it.each(YEARS)('has exactly two offset changes in %i, at the rule dates', async (year) => {
    const rule = ruleTransitions(year);
    // The change count is the guard: a rule change by the government fails here, not in reports.
    expect(await pgOffsetChanges(year), `PostgreSQL ${year}`).toEqual([rule.start, rule.end]);
    expect(intlOffsetChanges(year), `Node Intl ${year}`).toEqual([rule.start, rule.end]);
    expect(wallClock(rule.start - 1000).offsetHours).toBe(2);
    expect(wallClock(rule.start).offsetHours).toBe(3);
    expect(wallClock(rule.end - 1000).offsetHours).toBe(3);
    expect(wallClock(rule.end).offsetHours).toBe(2);
  });

  it.each(YEARS)('matches Node Intl for every row around the %i transitions', async (year) => {
    const { start, end } = ruleTransitions(year);
    for (const transition of [start, end]) {
      for (let ms = transition - 30 * HOUR; ms <= transition + 30 * HOUR; ms += HOUR) {
        for (const probe of [ms - 1000, ms, ms + 1000]) {
          expect(await dayOf(iso(probe)), `at ${iso(probe)}`).toBe(wallClock(probe).date);
        }
      }
    }
  });

  it.each(YEARS)(
    'makes the spring day 23 hours and the autumn day 25 hours in %i',
    async (year) => {
      const { start, end } = ruleTransitions(year);
      const springDay = wallClock(start).date;
      const autumnDay = wallClock(end).date;
      const spring = await hoursPerDay(start - 3 * 24 * HOUR, start + 3 * 24 * HOUR);
      const autumn = await hoursPerDay(end - 3 * 24 * HOUR, end + 3 * 24 * HOUR);
      expect(spring.get(springDay), `${springDay} hours`).toBe(23);
      expect(autumn.get(autumnDay), `${autumnDay} hours`).toBe(25);
      // The days either side stay 24 hours (the two window edge days are partial, so skip them).
      for (const [counts, day] of [
        [spring, springDay],
        [autumn, autumnDay],
      ] as const) {
        const others = [...counts.entries()]
          .filter(([other]) => other !== day)
          .sort(([a], [b]) => a.localeCompare(b));
        const inner = others.slice(1, -1);
        expect(inner.length, `${day} neighbours`).toBeGreaterThan(0);
        expect(
          inner.every(([, hours]) => hours === 24),
          `${day} neighbours are 24 hours`,
        ).toBe(true);
      }
    },
  );

  it('computes the dates the spec names from the rule', () => {
    expect(iso(ruleTransitions(2026).start)).toBe('2026-04-23T22:00:00Z');
    expect(iso(ruleTransitions(2026).end)).toBe('2026-10-29T21:00:00Z');
    expect(iso(ruleTransitions(2027).start)).toBe('2027-04-29T22:00:00Z');
    expect(iso(ruleTransitions(2027).end)).toBe('2027-10-28T21:00:00Z');
  });
});
