/**
 * Loads a history of past conversations into memory, so the agent's handling
 * of "what did I ask on 3 November?" can be tried without first using it for
 * a week.
 *
 *   npm run seed                      loads data/demo-history.json
 *   npm run seed -- my-history.json   loads your own file in the same format
 *   npm run seed -- --clear           removes everything a seed added
 *
 * Each entry's "at" is either "YYYY-MM-DD HH:MM" or "last <weekday> HH:MM"
 * (the most recent such weekday before today), read in the SEED_TZ timezone
 * (default: this machine's). The figures in the demo file are illustrative
 * snapshots. They exist to be re-checked by the agent, not to be relied on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { MemoryStore, type Digest } from "./memory/store.ts";
import { resolveTemporal } from "./time/temporal.ts";
import { formatDateTime, isValidTimeZone, nowMs } from "./time/zoned.ts";

interface SeedEntry {
  at: string;
  question: string;
  answer: string;
  sources?: Array<{ title: string; url: string }>;
  digest?: Digest;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SEED_PREFIX = "seed-";

function parseAt(at: string, now: number, timezone: string): number {
  const match = /^(.*?)\s+(\d{1,2}):(\d{2})$/.exec(at.trim());
  const [ref] = match ? resolveTemporal(match[1]!, now, timezone) : [];
  if (!match || !ref) throw new Error(`Cannot read the time "${at}". Use "YYYY-MM-DD HH:MM" or "last tuesday HH:MM".`);
  return ref.candidates[0]!.startMs + Number(match[2]) * 3_600_000 + Number(match[3]) * 60_000;
}

const store = new MemoryStore(join(ROOT, config.dbPath));
const timezone = isValidTimeZone(process.env.SEED_TZ) ? process.env.SEED_TZ : Intl.DateTimeFormat().resolvedOptions().timeZone;
const argument = process.argv[2];

// Seeding twice must not duplicate history, so earlier seeded entries go first.
const stale = store.listConversations().filter((c) => c.id.startsWith(SEED_PREFIX));
for (const conversation of stale) store.deleteConversation(conversation.id);

if (argument === "--clear") {
  console.log(`Removed ${stale.length} seeded conversation(s).`);
} else {
  const file = argument ?? join(ROOT, "data/demo-history.json");
  const entries = JSON.parse(readFileSync(file, "utf8")) as SeedEntry[];
  const now = nowMs();
  entries.forEach((entry, i) => {
    const createdAt = parseAt(entry.at, now, timezone);
    const conversationId = `${SEED_PREFIX}${i + 1}`;
    store.createConversation({
      id: conversationId,
      title: entry.digest?.title ?? entry.question.slice(0, 60),
      createdAt,
      updatedAt: createdAt,
    });
    store.saveTurn({
      id: `${SEED_PREFIX}turn-${i + 1}`,
      conversationId,
      createdAt,
      question: entry.question,
      contextNote: `Now: ${formatDateTime(createdAt, timezone)} (${timezone}).`,
      answer: entry.answer,
      sources: (entry.sources ?? []).map((source, n) => ({ n: n + 1, ...source })),
      searches: [],
      status: "complete",
      digest: entry.digest ?? null,
      stats: { seeded: true },
    });
    console.log(`  ${formatDateTime(createdAt, timezone)}  ${entry.question.slice(0, 70)}`);
  });
  console.log(`Seeded ${entries.length} past conversation(s) into ${config.dbPath} (times in ${timezone}).`);
}
store.close();
