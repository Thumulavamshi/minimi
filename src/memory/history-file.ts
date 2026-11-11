/**
 * Loads a file of past conversations into the store. Used by `npm run seed`
 * and by the live evaluation, which both need a known history to ask about.
 *
 * Each entry's "at" is either "YYYY-MM-DD HH:MM" or a phrase the date
 * resolver understands followed by a time, such as "last tuesday 11:20".
 */
import { resolveTemporal } from "../time/temporal.ts";
import { formatDateTime } from "../time/zoned.ts";
import type { Claim, Digest, MemoryStore, Turn } from "./store.ts";

export interface HistoryEntry {
  at: string;
  question: string;
  answer: string;
  sources?: Array<{ title: string; url: string }>;
  digest?: Omit<Digest, "claims"> & { claims: Array<string | Claim> };
}

export const SEED_PREFIX = "seed-";

function parseAt(at: string, now: number, timezone: string): number {
  const match = /^(.*?)\s+(\d{1,2}):(\d{2})$/.exec(at.trim());
  const [ref] = match ? resolveTemporal(match[1]!, now, timezone) : [];
  if (!match || !ref) throw new Error(`Cannot read the time "${at}". Use "YYYY-MM-DD HH:MM" or "last tuesday HH:MM".`);
  return ref.candidates[0]!.startMs + Number(match[2]) * 3_600_000 + Number(match[3]) * 60_000;
}

/** Inserts each entry as its own one-turn conversation and returns the stored turns. */
export function importHistory(store: MemoryStore, entries: HistoryEntry[], now: number, timezone: string): Turn[] {
  return entries.map((entry, i) => {
    const createdAt = parseAt(entry.at, now, timezone);
    const conversationId = `${SEED_PREFIX}${i + 1}`;
    store.createConversation({
      id: conversationId,
      title: entry.digest?.title ?? entry.question.slice(0, 60),
      createdAt,
      updatedAt: createdAt,
    });
    const turn: Turn = {
      id: `${SEED_PREFIX}turn-${i + 1}`,
      conversationId,
      createdAt,
      question: entry.question,
      contextNote: `Now: ${formatDateTime(createdAt, timezone)} (${timezone}).`,
      answer: entry.answer,
      sources: (entry.sources ?? []).map((source, n) => ({ n: n + 1, ...source })),
      searches: [],
      status: "complete",
      digest: entry.digest
        ? { ...entry.digest, claims: entry.digest.claims.map((c) => (typeof c === "string" ? { text: c, source: null } : c)) }
        : null,
      stats: { seeded: true },
    };
    store.saveTurn(turn);
    return turn;
  });
}
