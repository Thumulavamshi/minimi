/**
 * Finds the past turns a message refers to, before the model runs.
 *
 * The brief gives the agent one tool, web search, so memory cannot be a second
 * tool the model chooses to call. It is context instead: this module looks up
 * the relevant past turns with plain code and a local index, which takes a few
 * milliseconds and adds no model round-trip.
 *
 * Two signals drive the lookup:
 *   - dates in the message ("on 3 November") select turns by when they happened;
 *   - words that point at earlier conversation ("I asked you about Postgres")
 *     select turns by topic.
 *
 * When a date has no turns the result says so, and names the nearest days that
 * do have turns. An agent that is told "nothing was recorded on that day" can
 * answer honestly; one that is told nothing at all tends to invent a memory.
 */
import { resolveTemporal, type DateRange, type TemporalRef } from "../time/temporal.ts";
import { formatDateTime } from "../time/zoned.ts";
import type { MemoryStore, Turn } from "./store.ts";

export interface RecallHit {
  turn: Turn;
  /** Why this turn was recalled, for the model and for the UI. */
  reason: string;
}

export interface DateLookup {
  phrase: string;
  /** The reading of the phrase that was used. */
  range: DateRange;
  /** True when the first reading had no turns and a later reading did. */
  usedAlternate: boolean;
  /**
   * True when the phrase has more than one reading with recorded turns and
   * the topic does not tell them apart, e.g. "what did I ask last Tuesday?"
   * when both of the last two Tuesdays have conversations. A record existing
   * on a date does not prove it is the date the user meant.
   */
  ambiguous: boolean;
  /** Other readings that have records, but on topics the message does not mention. */
  otherDates: string[];
  hits: Turn[];
  /** Filled only when no reading had any turns. */
  nearest: { before: Turn | null; after: Turn | null } | null;
}

export interface Recall {
  refs: TemporalRef[];
  dateLookups: DateLookup[];
  topicHits: Turn[];
  /** Every recalled turn once, in the order it is shown to the model. */
  hits: RecallHit[];
  /**
   * Whether the message refers to an earlier conversation. If it only mentions
   * a date ("what happened in the markets yesterday?"), turns from that date
   * are listed in one line each instead of being quoted in full.
   */
  pointsBack: boolean;
  memoryIsEmpty: boolean;
}

export interface RecallInput {
  message: string;
  nowMs: number;
  timezone: string;
  /** Turns already replayed in full to the model as this conversation's history. */
  inContext: ReadonlySet<string>;
}

const MAX_DATE_HITS = 6;
const MAX_TOPIC_HITS = 3;
const ANSWER_BUDGET = 2400;

/**
 * Wording that points back at an earlier conversation: "I asked", "we
 * shortlisted", "you recommended", "what did I ask", "last time".
 * A false match costs little (a topic search and a few recalled turns), so
 * this leans towards matching.
 */
const PAST_VERB = "(?!need\\b)(?:\\w+ed|chose|went|said|told|spoke|gave|got|made|built|wrote|found|had|did|was|were)";
const RECALL_CUE = new RegExp(
  [
    `\\b(?:i|we|you)\\s+${PAST_VERB}\\b`,
    "\\b(?:did|have|had)\\s+(?:i|we|you)\\b",
    "\\b(?:i|we|you)(?:'ve|\\s+have)\\b",
    "\\b(?:last|previous|earlier|prior|other)\\s+(?:time|chat|conversation|session|discussion|answer)\\b",
    "\\bour\\s+(?:chat|conversation|discussion|shortlist|list)\\b",
    "\\b(?:your|that|the)\\s+(?:earlier|previous|last|old)\\s+(?:answer|recommendation|reply|response|list)\\b",
    "\\b(?:previously|remember|recall|again|still\\s+(?:correct|true|accurate|valid|right|the\\s+case))\\b",
    "\\bsince\\s+(?:then|we|i|our)\\b",
  ].join("|"),
  "i",
);

const STOPWORDS = new Set(
  `a about above after again all also am an and any are as ask asked at be because been before being below between both
  but by can change changed correct could did do does doing down during each few for from further had has have having he
  her here hers him his how i if in into is it its just last me more most my no nor not now of off on once only or other
  our out over own same she should since so some still such than that the their them then there these they this those
  through to today too under until up us very was we were what when where which while who whom why will with would
  yesterday you your yours tell told said say know anything something please thanks answer question talked discussed
  remember recall previously earlier time day week month monday tuesday wednesday thursday friday saturday sunday january
  february march april may june july august september october november december`.split(/\s+/),
);

/** The content words of a message: lowercased, deduplicated, without filler. */
export function keywords(message: string): string[] {
  const words = message.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length > 1 && !STOPWORDS.has(w) && !/^\d+$/.test(w)))];
}

/** How many of the keywords appear in the turn. Used to order turns from one day. */
function overlap(turn: Turn, words: string[]): number {
  const text = `${turn.question} ${turn.digest?.title ?? ""} ${turn.digest?.entities.join(" ") ?? ""}`.toLowerCase();
  return words.filter((w) => text.includes(w)).length;
}

export function recall(store: MemoryStore, input: RecallInput): Recall {
  const refs = resolveTemporal(input.message, input.nowMs, input.timezone);
  const words = keywords(input.message);
  const pointsBack = RECALL_CUE.test(input.message);
  const seen = new Set<string>();
  const hits: RecallHit[] = [];
  const dateLookups: DateLookup[] = [];
  /** Whether any turn found by date shares a topic word with the message. */
  let dateHitOnTopic = false;

  for (const ref of refs) {
    const reachesNow = ref.candidates[0]!.endMs > input.nowMs;
    // Look at every reading of the phrase, not just the likeliest.
    const withRecords = ref.candidates.flatMap((range, i) => {
      // Stop at the present so that "today" cannot match the question being asked.
      const found = store.turnsBetween(range.startMs, Math.min(range.endMs, input.nowMs));
      if (found.length === 0) return [];
      const kept = [...found]
        .sort((a, b) => overlap(b, words) - overlap(a, words) || a.createdAt - b.createdAt)
        .slice(0, MAX_DATE_HITS);
      return [{ range, kept, isAlternate: i > 0, onTopic: kept.some((turn) => overlap(turn, words) > 0) }];
    });
    // When more than one reading has records, the topic decides if it can:
    // "last Tuesday I asked about Postgres" means the Tuesday with the
    // Postgres conversation. If the topic does not separate them, every
    // reading is kept and the model is told to ask rather than choose.
    const topical = withRecords.filter((reading) => reading.onTopic);
    const settled = topical.length > 0 && topical.length < withRecords.length;
    const readings = settled ? topical : withRecords;
    const otherDates = settled ? withRecords.filter((reading) => !reading.onTopic).map((reading) => reading.range.label) : [];
    for (const { range, kept, isAlternate } of readings) {
      for (const turn of kept) {
        if (seen.has(turn.id)) continue;
        seen.add(turn.id);
        hits.push({ turn, reason: `asked on ${range.label}` });
      }
      if (kept.some((turn) => overlap(turn, words) > 0)) dateHitOnTopic = true;
      dateLookups.push({
        phrase: ref.phrase,
        range,
        usedAlternate: isAlternate && withRecords.length === 1,
        ambiguous: readings.length > 1,
        otherDates,
        hits: kept,
        nearest: null,
      });
    }
    // "Nothing was recorded on that day" is worth saying only when the user
    // asked about a past day. "Is it still true today?" is not such a question.
    if (readings.length === 0 && pointsBack && !reachesNow) {
      const first = ref.candidates[0]!;
      dateLookups.push({
        phrase: ref.phrase,
        range: first,
        usedAlternate: false,
        ambiguous: false,
        otherDates: [],
        hits: [],
        nearest: store.nearest(first.startMs, first.endMs),
      });
    }
  }

  // The topic search runs when the message points at the past and the date
  // did not find the conversation: either the date found nothing, or what it
  // found is about something else ("last Friday I asked about Postgres", when
  // Friday's only conversation was about TypeScript). When a turn found by
  // date does match the topic, the user has identified the conversation, and
  // loosely related turns from other days would only dilute it.
  const topicHits: Turn[] = [];
  if (pointsBack && words.length > 0 && !dateHitOnTopic) {
    for (const turn of store.search(words, MAX_TOPIC_HITS)) {
      if (seen.has(turn.id)) continue;
      seen.add(turn.id);
      topicHits.push(turn);
      hits.push({ turn, reason: "related by topic" });
    }
  }

  return { refs, dateLookups, topicHits, hits, pointsBack, memoryIsEmpty: store.countTurns() === 0 };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()} […]`;
}

function renderTurn(turn: Turn, input: RecallInput, inFull: boolean): string {
  const when = formatDateTime(turn.createdAt, input.timezone);
  if (!inFull) return `  - ${when}: "${clip(turn.question, 160)}"`;
  if (input.inContext.has(turn.id)) {
    return `  - ${when}: "${clip(turn.question, 160)}" (this turn is in the current conversation above)`;
  }
  const lines = [`  <past_turn asked="${when}">`, `  User asked: ${clip(turn.question, 600)}`];
  if (turn.status !== "complete") lines.push("  (That answer was cut short and is incomplete.)");
  lines.push(`  You answered: ${clip(turn.answer, ANSWER_BUDGET) || "(no answer was recorded)"}`);
  const claims = turn.digest?.claims ?? [];
  if (claims.length > 0) {
    lines.push("  Claims recorded from that answer (each is something to re-check, not a current fact):");
    claims.forEach((claim, i) => lines.push(`    ${i + 1}. ${claim.text}${claim.source ? ` (source then: ${claim.source})` : ""}`));
  }
  lines.push("  </past_turn>");
  return lines.join("\n");
}

function describeNearest(turn: Turn | null, timezone: string): string | null {
  return turn ? `${formatDateTime(turn.createdAt, timezone)} ("${clip(turn.question, 90)}")` : null;
}

/**
 * The block placed in front of the user's message. It carries the current
 * time, the dates the app resolved, and whatever memory the lookup found.
 */
export function renderContext(result: Recall, input: RecallInput): string {
  const lines = [`Now: ${formatDateTime(input.nowMs, input.timezone)} (${input.timezone}).`];

  if (result.refs.length > 0) {
    lines.push("Dates in the user's message, resolved by the app (use these; do not recompute them):");
    for (const ref of result.refs) {
      const [first, ...rest] = ref.candidates.map((c) => c.label);
      lines.push(`  - "${ref.phrase}" = ${first}${rest.length ? ` (could also mean ${rest.join(" or ")})` : ""}`);
    }
  }

  if (result.memoryIsEmpty) {
    lines.push("Memory: no earlier conversations are recorded. This is the first one.");
    return lines.join("\n");
  }
  if (result.dateLookups.length === 0 && result.topicHits.length === 0) return lines.join("\n");

  lines.push(
    "Memory lookup (run automatically; it shows what was said at the time, which is not evidence of what is true now):",
  );
  const flagged = new Set<string>();
  for (const lookup of result.dateLookups) {
    if (lookup.ambiguous && !flagged.has(lookup.phrase)) {
      flagged.add(lookup.phrase);
      lines.push(
        `- "${lookup.phrase}" could mean more than one date, and more than one has recorded turns (listed next, in brief). Nothing in the message shows which the user means, so tell them what is recorded on each and ask which day they mean; do not pick one.`,
      );
    }
    if (lookup.hits.length > 0) {
      const note = lookup.usedAlternate
        ? ` (nothing on the first reading of "${lookup.phrase}", so this is the other one)`
        : lookup.otherDates.length
          ? ` (chosen by topic; "${lookup.phrase}" could also mean ${lookup.otherDates.join(" or ")}, which has records on other topics)`
          : "";
      lines.push(`- ${lookup.range.label}${note}: ${lookup.hits.length} recorded turn(s).`);
      for (const turn of lookup.hits) lines.push(renderTurn(turn, input, result.pointsBack && !lookup.ambiguous));
      continue;
    }
    const near = [describeNearest(lookup.nearest?.before ?? null, input.timezone), describeNearest(lookup.nearest?.after ?? null, input.timezone)]
      .filter(Boolean)
      .join("; ");
    lines.push(`- ${lookup.range.label}: nothing was recorded.${near ? ` Nearest recorded turns: ${near}.` : ""}`);
  }
  if (result.topicHits.length > 0) {
    lines.push("- Related by topic, from other dates:");
    for (const turn of result.topicHits) lines.push(renderTurn(turn, input, true));
  }
  return lines.join("\n");
}
