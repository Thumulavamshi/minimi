/**
 * Turns the time phrases in a message ("last Tuesday", "3 November",
 * "two weeks ago") into exact date ranges.
 *
 * This is ordinary code on purpose. Language models are unreliable at calendar
 * arithmetic, and a wrong date here means recalling the wrong conversation, so
 * the model is handed the answer instead of being asked to work it out.
 *
 * Where a phrase is genuinely ambiguous ("last Tuesday" said on a Thursday),
 * the resolver returns every reading, most likely first, and the memory lookup
 * tries each one.
 */
import {
  type CivilDate,
  addDays,
  addMonths,
  compareCivil,
  daysInMonth,
  formatDay,
  isRealDate,
  startOfDayMs,
  weekdayOf,
  zonedParts,
} from "./zoned.ts";

export interface DateRange {
  /** Inclusive. */
  startMs: number;
  /** Exclusive. */
  endMs: number;
  /** "Tue 3 Nov 2026" or "Mon 2 Nov 2026 – Sun 8 Nov 2026" */
  label: string;
}

export interface TemporalRef {
  /** The words as the user wrote them. */
  phrase: string;
  index: number;
  /** Possible readings, most likely first. Never empty. */
  candidates: DateRange[];
}

/** An inclusive run of civil days. */
interface Span {
  from: CivilDate;
  to: CivilDate;
}

interface Rule {
  pattern: RegExp;
  /** Returns the readings of a match, or null if it is not a past date. */
  resolve(match: RegExpExecArray, today: CivilDate): Span[] | null;
}

const MONTH_INDEX: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
// Longest names first so "september" is not read as "sep".
const MONTH_NAMES = Object.keys(MONTH_INDEX).sort((a, b) => b.length - a.length).join("|");
const FULL_MONTH_NAMES =
  "january|february|march|april|may|june|july|august|september|october|november|december";

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

const COUNT_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, couple: 2, few: 3,
};
const COUNT = "\\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|(?:a\\s+)?couple(?:\\s+of)?|(?:a\\s+)?few";

function parseCount(raw: string): number {
  const text = raw.toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  if (text.includes("couple")) return 2;
  if (text.includes("few")) return 3;
  return COUNT_WORDS[text] ?? 1;
}

const day = (date: CivilDate): Span => ({ from: date, to: date });

/** "may" is also an ordinary verb, so only a capitalised "May" counts as the month. */
function isMonthWord(word: string): boolean {
  return word.toLowerCase() !== "may" || word === "May";
}

/** A day and month with no year means its most recent occurrence. */
function mostRecent(month: number, dayOfMonth: number, year: number | undefined, today: CivilDate): CivilDate | null {
  if (year !== undefined) return isRealDate(year, month, dayOfMonth) ? { y: year, m: month, d: dayOfMonth } : null;
  for (const y of [today.y, today.y - 1, today.y - 2, today.y - 3, today.y - 4]) {
    if (!isRealDate(y, month, dayOfMonth)) continue; // 29 Feb outside a leap year
    const candidate = { y, m: month, d: dayOfMonth };
    if (compareCivil(candidate, today) <= 0) return candidate;
  }
  return null;
}

function mondayOf(date: CivilDate): CivilDate {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

function resolveWeekday(prefix: string | undefined, name: string, today: CivilDate): Span[] | null {
  const lead = prefix?.toLowerCase();
  if (lead && /^(next|coming|every|by|until|till)$/.test(lead)) return null; // not the past
  const target = WEEKDAY_INDEX[name.toLowerCase()];
  if (target === undefined) return null;
  const back = (weekdayOf(today) - target + 7) % 7;

  if (lead === "last" || lead === "past" || lead === "previous") {
    const primary = addDays(today, -(back === 0 ? 7 : back));
    // Said on a Thursday, "last Tuesday" can mean two days ago or the Tuesday
    // of the week before. Offer both when the nearer one is in this week.
    const inThisWeek = compareCivil(primary, mondayOf(today)) >= 0;
    return inThisWeek ? [day(primary), day(addDays(primary, -7))] : [day(primary)];
  }
  // "on Monday", said on a Monday, most likely means today.
  if (back === 0) return [day(today), day(addDays(today, -7))];
  return [day(addDays(today, -back))];
}

const RULES: Rule[] = [
  {
    // 2026-11-03
    pattern: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g,
    resolve: (m) => {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return isRealDate(y, mo, d) ? [day({ y, m: mo, d })] : null;
    },
  },
  {
    // 3 November, 3rd of Nov, 3 Nov 2026
    pattern: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${MONTH_NAMES})\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, "gi"),
    resolve: (m, today) => {
      if (!isMonthWord(m[2]!)) return null;
      const date = mostRecent(MONTH_INDEX[m[2]!.toLowerCase()]!, Number(m[1]), m[3] ? Number(m[3]) : undefined, today);
      return date ? [day(date)] : null;
    },
  },
  {
    // November 3, Nov 3rd, November 3, 2026
    pattern: new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, "gi"),
    resolve: (m, today) => {
      if (!isMonthWord(m[1]!)) return null;
      const date = mostRecent(MONTH_INDEX[m[1]!.toLowerCase()]!, Number(m[2]), m[3] ? Number(m[3]) : undefined, today);
      return date ? [day(date)] : null;
    },
  },
  {
    // 03/11/2026. Day-first is the likelier reading; month-first is the alternative.
    pattern: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,
    resolve: (m) => {
      const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const spans: Span[] = [];
      if (isRealDate(y, b, a)) spans.push(day({ y, m: b, d: a }));
      if (a !== b && isRealDate(y, a, b)) spans.push(day({ y, m: a, d: b }));
      return spans.length ? spans : null;
    },
  },
  {
    // in October, last March, during November 2025: the whole month
    pattern: new RegExp(`\\b(?:in|during|last|this)\\s+(${FULL_MONTH_NAMES})\\b(?:\\s+(\\d{4})\\b)?`, "gi"),
    resolve: (m, today) => {
      if (!isMonthWord(m[1]!)) return null;
      const month = MONTH_INDEX[m[1]!.toLowerCase()]!;
      const first = mostRecent(month, 1, m[2] ? Number(m[2]) : undefined, today);
      return first ? [{ from: first, to: { ...first, d: daysInMonth(first.y, first.m) } }] : null;
    },
  },
  { pattern: /\bday\s+before\s+yesterday\b/gi, resolve: (_m, today) => [day(addDays(today, -2))] },
  { pattern: /\byesterday\b|\blast\s+night\b/gi, resolve: (_m, today) => [day(addDays(today, -1))] },
  {
    pattern: /\b(?:earlier\s+)?today\b|\bthis\s+(?:morning|afternoon|evening)\b/gi,
    resolve: (_m, today) => [day(today)],
  },
  {
    // on Monday, last Tuesday, this Friday
    pattern: /\b(?:(last|this|past|previous|on|next|coming|every|by|until|till)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
    resolve: (m, today) => resolveWeekday(m[1], m[2]!, today),
  },
  {
    // Short names only after a preposition: bare "sat" or "sun" are usually other words.
    pattern: /\b(last|this|on)\s+(mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)\b/gi,
    resolve: (m, today) => resolveWeekday(m[1], m[2]!, today),
  },
  {
    // 3 days ago, two weeks back, a month ago. Longer units are remembered
    // less precisely, so they resolve to a window around the exact date.
    pattern: new RegExp(`\\b(${COUNT})\\s+(day|week|month|year)s?\\s+(?:ago|back|earlier)\\b`, "gi"),
    resolve: (m, today) => {
      const n = parseCount(m[1]!);
      switch (m[2]!.toLowerCase()) {
        case "day":
          return [day(addDays(today, -n))];
        case "week": {
          const centre = addDays(today, -7 * n);
          return [{ from: addDays(centre, -3), to: addDays(centre, 3) }];
        }
        case "month": {
          const centre = addMonths(today, -n);
          return [{ from: addDays(centre, -10), to: addDays(centre, 10) }];
        }
        default: {
          const centre = addMonths(today, -12 * n);
          return [{ from: addDays(centre, -30), to: addDays(centre, 30) }];
        }
      }
    },
  },
  {
    pattern: /\b(?:a\s+)?fortnight\s+(?:ago|back)\b/gi,
    resolve: (_m, today) => [{ from: addDays(today, -17), to: addDays(today, -11) }],
  },
  {
    // the last 3 days, past two weeks, over the last few months: up to today
    pattern: new RegExp(`\\b(?:last|past)\\s+(${COUNT})\\s+(day|week|month)s\\b`, "gi"),
    resolve: (m, today) => {
      const n = parseCount(m[1]!);
      const unit = m[2]!.toLowerCase();
      const from = unit === "day" ? addDays(today, -n) : unit === "week" ? addDays(today, -7 * n) : addMonths(today, -n);
      return [{ from, to: today }];
    },
  },
  {
    pattern: /\b(last|this|earlier\s+this)\s+week\b/gi,
    resolve: (m, today) => {
      const monday = mondayOf(today);
      return m[1]!.toLowerCase() === "last"
        ? [{ from: addDays(monday, -7), to: addDays(monday, -1) }]
        : [{ from: monday, to: today }];
    },
  },
  {
    pattern: /\b(?:last|this\s+past|over\s+the|at\s+the|this)\s+weekend\b/gi,
    resolve: (_m, today) => {
      // The most recent Saturday that has already begun.
      const saturday = addDays(today, -((weekdayOf(today) + 1) % 7 || 7));
      return [{ from: saturday, to: addDays(saturday, 1) }];
    },
  },
  {
    pattern: /\b(last|this|earlier\s+this)\s+month\b/gi,
    resolve: (m, today) => {
      if (m[1]!.toLowerCase() !== "last") return [{ from: { ...today, d: 1 }, to: today }];
      const previous = addMonths({ ...today, d: 1 }, -1);
      return [{ from: previous, to: { ...previous, d: daysInMonth(previous.y, previous.m) } }];
    },
  },
  {
    pattern: /\blast\s+year\b/gi,
    resolve: (_m, today) => [{ from: { y: today.y - 1, m: 1, d: 1 }, to: { y: today.y - 1, m: 12, d: 31 } }],
  },
  {
    pattern: /\b(?:recently|lately|the\s+other\s+day)\b/gi,
    resolve: (_m, today) => [{ from: addDays(today, -14), to: today }],
  },
];

export function resolveTemporal(text: string, nowMs: number, tz: string): TemporalRef[] {
  const today: CivilDate = (({ y, m, d }) => ({ y, m, d }))(zonedParts(nowMs, tz));
  const found: Array<{ phrase: string; index: number; spans: Span[] }> = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(text); match; match = rule.pattern.exec(text)) {
      const spans = (rule.resolve(match, today) ?? [])
        // Memory only holds the past: drop future readings, clip ranges at today.
        .filter((span) => compareCivil(span.from, today) <= 0)
        .map((span) => (compareCivil(span.to, today) > 0 ? { from: span.from, to: today } : span));
      found.push({ phrase: match[0], index: match.index, spans });
    }
  }

  // When phrases overlap ("day before yesterday" contains "yesterday"), the
  // longer one wins. A match that resolved to nothing still claims its text,
  // so "next Monday" is not re-read as a bare "Monday".
  found.sort((a, b) => b.phrase.length - a.phrase.length || a.index - b.index);
  const kept: typeof found = [];
  for (const item of found) {
    const end = item.index + item.phrase.length;
    if (!kept.some((k) => item.index < k.index + k.phrase.length && k.index < end)) kept.push(item);
  }

  return kept
    .filter((item) => item.spans.length > 0)
    .sort((a, b) => a.index - b.index)
    .map((item) => ({
      phrase: item.phrase,
      index: item.index,
      candidates: item.spans.map((span) => ({
        startMs: startOfDayMs(span.from, tz),
        endMs: startOfDayMs(addDays(span.to, 1), tz),
        label: compareCivil(span.from, span.to) === 0 ? formatDay(span.from) : `${formatDay(span.from)} – ${formatDay(span.to)}`,
      })),
    }));
}
