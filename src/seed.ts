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
import { importHistory, SEED_PREFIX, type HistoryEntry } from "./memory/history-file.ts";
import { MemoryStore } from "./memory/store.ts";
import { formatDateTime, isValidTimeZone, nowMs } from "./time/zoned.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  const entries = JSON.parse(readFileSync(file, "utf8")) as HistoryEntry[];
  const turns = importHistory(store, entries, nowMs(), timezone);
  for (const turn of turns) console.log(`  ${formatDateTime(turn.createdAt, timezone)}  ${turn.question.slice(0, 70)}`);
  console.log(`Seeded ${turns.length} past conversation(s) into ${config.dbPath} (times in ${timezone}).`);
}
store.close();
