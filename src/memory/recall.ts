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

  for (const ref of refs) {
    const reachesNow = ref.candidates[0]!.endMs > input.nowMs;
    let matched = false;
    for (const [i, range] of ref.candidates.entries()) {
      // Stop at the present so that "today" cannot match the question being asked.
      const found = store.turnsBetween(range.startMs, Math.min(range.endMs, input.nowMs));
      if (found.length === 0) continue;
      const kept = [...found]
        .sort((a, b) => overlap(b, words) - overlap(a, words) || a.createdAt - b.createdAt)
        .slice(0, MAX_DATE_HITS);
      for (const turn of kept) {
        if (seen.has(turn.id)) continue;
        seen.add(turn.id);
        hits.push({ turn, reason: `asked on ${range.label}` });
      }
      dateLookups.push({ phrase: ref.phrase, range, usedAlternate: i > 0, hits: kept, nearest: null });
      matched = true;
      break;
    }
    // "Nothing was recorded on that day" is worth saying only when the user
    // asked about a past day. "Is it still true today?" is not such a question.
    if (!matched && pointsBack && !reachesNow) {
      const first = ref.candidates[0]!;
      dateLookups.push({
        phrase: ref.phrase,
        range: first,
        usedAlternate: false,
        hits: [],
        nearest: store.nearest(first.startMs, first.endMs),
      });
    }
  }

  // The topic search runs only when the message points at the past. For an
  // ordinary question the timeline in the system prompt is context enough.
  const topicHits: Turn[] = [];
  if (pointsBack && words.length > 0) {
    for (const turn of store.search(words, MAX_TOPIC_HITS + seen.size)) {
      if (seen.has(turn.id) || topicHits.length >= MAX_TOPIC_HITS) continue;
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
  for (const lookup of result.dateLookups) {
    if (lookup.hits.length > 0) {
      const note = lookup.usedAlternate ? ` (nothing on the first reading of "${lookup.phrase}", so this is the other one)` : "";
      lines.push(`- ${lookup.range.label}${note}: ${lookup.hits.length} recorded turn(s).`);
      for (const turn of lookup.hits) lines.push(renderTurn(turn, input, result.pointsBack));
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
