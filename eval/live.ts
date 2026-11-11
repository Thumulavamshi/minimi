/**
 * Runs the whole agent against the real model and the real web, and checks
 * each answer with simple rules.
 *
 *   npm run eval:live                 with the demo history loaded
 *   npm run eval:live -- --no-memory  the same questions with an empty memory,
 *                                     to show what the memory layer contributes
 *
 * Needs GROQ_API_KEY. It uses a throwaway in-memory store, so it does not
 * touch your real conversations. Results are printed and written to
 * eval/live-results.md.
 *
 * This layer is small on purpose. Groq's free tier allows only a few thousand
 * tokens a minute, so the run pauses between questions, and the checks are
 * rules rather than a second model grading the first. Live prices move, so no
 * scenario asserts that a particular price changed; they check behaviour:
 * did it recall the right day, admit a gap, search when it should, and cite
 * pages its searches actually returned.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runTurn, type TurnEvent } from "../src/agent/turn.ts";
import { config } from "../src/config.ts";
import { importHistory, type HistoryEntry } from "../src/memory/history-file.ts";
import { MemoryStore, type Turn } from "../src/memory/store.ts";
import { formatDay, nowMs, zonedParts } from "../src/time/zoned.ts";

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Spacing between questions, to stay inside the free tier's per-minute token allowance. */
const PAUSE_MS = Number(process.env.EVAL_PAUSE_MS) || 25_000;
const RATE_LIMIT_WAIT_MS = 65_000;

interface Result {
  turn: Turn | null;
  error: string | null;
  recalled: number;
}

interface LiveScenario {
  name: string;
  message: string;
  /** Each check returns null when satisfied, or a short reason when not. */
  checks: Array<(result: Result) => string | null>;
}

const answer = (r: Result) => r.turn?.answer ?? "";
const mentions = (pattern: RegExp, what: string) => (r: Result) => (pattern.test(answer(r)) ? null : `answer does not mention ${what}`);
const searched = (r: Result) => ((r.turn?.searches.length ?? 0) > 0 ? null : "did not search the web");
const didNotSearch = (r: Result) => ((r.turn?.searches.length ?? 0) === 0 ? null : "searched when it did not need to");
const recalledSomething = (r: Result) => (r.recalled > 0 ? null : "recalled no earlier turn");
const admitsNoRecord = mentions(/no record|not recorded|nothing (was |is )?recorded|don't have|do not have|no (earlier |previous )?conversation|couldn't find|could not find|no memory/i, "that nothing is recorded");
/** Every cited link must be a page the search returned or one carried over from memory. */
const linksAreGrounded = (r: Result) => {
  const bad = (r.turn?.sources ?? []).filter((s) => s.origin === "unlisted");
  return bad.length === 0 ? null : `${bad.length} cited link(s) were not in the search results: ${bad.map((s) => s.url).join(", ")}`;
};

const today = formatDay(zonedParts(nowMs(), TIMEZONE));
const year = String(zonedParts(nowMs(), TIMEZONE).y);

const SCENARIOS: LiveScenario[] = [
  {
    name: "Recalls an exact date and re-checks it",
    message: "What did I ask you on 3 November? Is your answer still correct today?",
    checks: [recalledSomething, mentions(/node/i, "Node.js"), mentions(/3 Nov/i, "the date 3 November"), searched, linksAreGrounded],
  },
  {
    name: "Recalls by weekday and topic, compares then and now",
    message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    checks: [recalledSomething, mentions(/neon/i, "Neon"), mentions(/supabase/i, "Supabase"), searched, linksAreGrounded],
  },
  {
    name: "Recalls a shortlist and checks each item",
    message: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    checks: [recalledSomething, mentions(/hubspot/i, "HubSpot"), mentions(/pipedrive/i, "Pipedrive"), mentions(/zoho/i, "Zoho"), searched, linksAreGrounded],
  },
  {
    name: "Admits a day with no record",
    message: "What did I ask you on 1 November?",
    checks: [admitsNoRecord, didNotSearch],
  },
  {
    name: "Finds a conversation from a loose description",
    message: "A while back you helped me pick somewhere to run my database. Which did you favour?",
    checks: [mentions(/neon|supabase/i, "Neon or Supabase"), didNotSearch],
  },
  {
    name: "Searches for a current fact and cites it",
    message: "What is the latest stable version of PostgreSQL?",
    checks: [searched, mentions(/\d+\.\d+|\b1[6-9]\b|\b2\d\b/, "a version number"), linksAreGrounded],
  },
  {
    name: "Knows today's date without searching",
    message: "What is today's date?",
    checks: [mentions(new RegExp(year), "the current year"), didNotSearch],
  },
  {
    name: "Does not search for small talk",
    message: "Thanks, that's all for now!",
    checks: [didNotSearch],
  },
  {
    name: "Does not search for settled knowledge",
    message: "In one sentence, what is a database index?",
    checks: [didNotSearch, mentions(/index/i, "an index")],
  },
];

async function ask(store: MemoryStore, message: string): Promise<Result> {
  const result: Result = { turn: null, error: null, recalled: 0 };
  const emit = (event: TurnEvent): void => {
    if (event.type === "start") result.recalled = event.recalled.length;
    if (event.type === "done") result.turn = event.turn;
    if (event.type === "error") result.error = event.message;
  };
  // Each question starts its own conversation, as a user returning later would.
  await runTurn({ store, config }, { message, timezone: TIMEZONE, signal: new AbortController().signal, emit });
  return result;
}

if (!config.hasApiKey) {
  console.error("GROQ_API_KEY is not set. Add it to .env to run the live evaluation.");
  process.exit(1);
}

const withMemory = !process.argv.includes("--no-memory");
const store = new MemoryStore(":memory:");
if (withMemory) {
  const file = fileURLToPath(new URL("../data/demo-history.json", import.meta.url));
  importHistory(store, JSON.parse(readFileSync(file, "utf8")) as HistoryEntry[], nowMs(), TIMEZONE);
}

console.log(`Live evaluation: ${SCENARIOS.length} questions, ${config.model}, memory ${withMemory ? "loaded" : "empty"}. Pausing ${PAUSE_MS / 1000} s between questions.\n`);
const rows: string[] = [];
let passedCount = 0;

for (const [i, scenario] of SCENARIOS.entries()) {
  if (i > 0) await sleep(PAUSE_MS);
  let result = await ask(store, scenario.message);
  if (result.error && /rate limit/i.test(result.error)) {
    console.log("  rate limited; waiting a minute and retrying once");
    await sleep(RATE_LIMIT_WAIT_MS);
    result = await ask(store, scenario.message);
  }
  const problems = result.turn ? scenario.checks.map((check) => check(result)).filter((p): p is string => p !== null) : [`no answer: ${result.error}`];
  const passed = problems.length === 0;
  if (passed) passedCount++;
  const stats = result.turn?.stats;
  const timing = stats?.totalMs ? `${(stats.totalMs / 1000).toFixed(1)} s (first words ${((stats.firstTokenMs ?? 0) / 1000).toFixed(1)} s)` : "n/a";
  console.log(`${passed ? "PASS" : "FAIL"}  ${scenario.name}  [${timing}, ${result.turn?.searches.length ?? 0} searches]`);
  for (const problem of problems) console.log(`      ${problem}`);
  rows.push(`| ${scenario.name} | ${passed ? "pass" : "**fail**"} | ${result.turn?.searches.length ?? 0} | ${timing} | ${problems.join("; ").replace(/\|/g, "/") || ""} |`);
}

const report = [
  `# Live evaluation (${withMemory ? "memory loaded" : "empty memory"})`,
  "",
  `Generated by \`npm run eval:live${withMemory ? "" : " -- --no-memory"}\` on ${today} with \`${config.model}\` (effort: ${config.effort}).`,
  "Answers come from a live model and the live web, so results vary from run to run.",
  "",
  `**${passedCount} / ${SCENARIOS.length} passed.**`,
  "",
  "| Scenario | Result | Searches | Time | Notes |",
  "|---|---|---|---|---|",
  ...rows,
  "",
].join("\n");
const file = withMemory ? "live-results.md" : "live-results-no-memory.md";
writeFileSync(fileURLToPath(new URL(file, import.meta.url)), report);
console.log(`\n${passedCount} / ${SCENARIOS.length} passed. Report written to eval/${file}`);
await sleep(3000); // let the last background summary finish before the store closes
store.close();
