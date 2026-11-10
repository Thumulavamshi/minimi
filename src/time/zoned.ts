/**
 * Calendar arithmetic in the user's timezone, with no date library.
 *
 * Timestamps are stored as UTC milliseconds. "3 November" only means something
 * in a timezone, so every day boundary is computed here from an IANA zone name
 * the browser sends with each message.
 */

export interface CivilDate {
  y: number;
  /** 1-12 */
  m: number;
  d: number;
}

export interface ZonedParts extends CivilDate {
  hour: number;
  minute: number;
  second: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant, as seen in `tz`. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const part of formatterFor(tz).formatToParts(new Date(ms))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    y: out.year ?? 0,
    m: out.month ?? 1,
    d: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

function offsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const wallAsUtc = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant at which the civil day begins in `tz`. */
export function startOfDayMs(date: CivilDate, tz: string): number {
  const guess = Date.UTC(date.y, date.m - 1, date.d);
  // Two passes: the offset at the guess can differ from the offset at the
  // real local midnight when a DST change falls in between.
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

/** Adding days through Date.UTC normalises month and year overflow. */
export function addDays(date: CivilDate, days: number): CivilDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Same day-of-month `months` away, clamped to the month's last day. */
export function addMonths(date: CivilDate, months: number): CivilDate {
  const first = new Date(Date.UTC(date.y, date.m - 1 + months, 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth() + 1;
  return { y, m, d: Math.min(date.d, daysInMonth(y, m)) };
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isRealDate(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** 0 = Sunday. */
export function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}

export function compareCivil(a: CivilDate, b: CivilDate): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

/** "Tue 3 Nov 2026" */
export function formatDay(date: CivilDate): string {
  return `${WEEKDAYS[weekdayOf(date)]} ${date.d} ${MONTHS[date.m - 1]} ${date.y}`;
}

/** "Tue 3 Nov 2026, 14:05" */
export function formatDateTime(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${formatDay(p)}, ${hh}:${mm}`;
}

/**
 * The current instant. AGENT_NOW (an ISO timestamp) overrides the system
 * clock so that tests, and anyone trying the agent, can move through days
 * without waiting for them.
 */
export function nowMs(): number {
  const override = process.env.AGENT_NOW;
  if (override) {
    const parsed = Date.parse(override);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}
