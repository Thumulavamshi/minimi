import assert from "node:assert/strict";
import { test } from "node:test";
import { recall, renderContext, keywords, type RecallInput } from "../src/memory/recall.ts";
import { MemoryStore, type Turn } from "../src/memory/store.ts";
import { renderTimeline } from "../src/memory/timeline.ts";

const TZ = "Asia/Kolkata";
/** Tuesday 10 November 2026, 14:30 in Bengaluru. */
const NOW = Date.parse("2026-11-10T09:00:00Z");

function turn(id: string, iso: string, question: string, answer: string, conversationId = `c-${id}`): Turn {
  return {
    id,
    conversationId,
    createdAt: Date.parse(iso),
    question,
    contextNote: "",
    answer,
    sources: [],
    searches: [],
    status: "complete",
    digest: null,
    stats: {},
  };
}

function storeWith(...turns: Turn[]): MemoryStore {
  const store = new MemoryStore(":memory:");
  for (const t of turns) {
    if (!store.getConversation(t.conversationId)) {
      store.createConversation({ id: t.conversationId, title: t.question, createdAt: t.createdAt, updatedAt: t.createdAt });
    }
    store.saveTurn(t);
  }
  return store;
}

const POSTGRES = turn(
  "pg",
  "2026-11-03T06:00:00Z", // Tue 3 Nov, 11:30 IST
  "Which managed Postgres hosting should I use for a small SaaS?",
  "Neon Launch starts at $19/month and Supabase Pro is $25/month.",
);
const CRM = turn(
  "crm",
  "2026-11-09T05:00:00Z", // Mon 9 Nov, 10:30 IST
  "Shortlist 5 CRM tools for a 20-person sales team",
  "HubSpot, Pipedrive, Salesforce, Zoho CRM and Close.",
);
const RECIPE = turn("dal", "2026-11-05T13:00:00Z", "How do I make dal tadka?", "Boil the lentils, then temper cumin in ghee.");

function ask(store: MemoryStore, message: string, inContext: string[] = []) {
  const input: RecallInput = { message, nowMs: NOW, timezone: TZ, inContext: new Set(inContext) };
  const result = recall(store, input);
  return { result, context: renderContext(result, input) };
}

test("'What did I ask you on 3 November?' recalls that day's turn in full", () => {
  const { result, context } = ask(storeWith(POSTGRES, CRM, RECIPE), "What did I ask you on 3 November? Is your answer still correct today?");
  assert.deepEqual(result.hits.map((h) => h.turn.id), ["pg"]);
  assert.match(context, /"3 November" = Tue 3 Nov 2026/);
  assert.match(context, /<past_turn asked="Tue 3 Nov 2026, 11:30">/);
  assert.match(context, /Neon Launch starts at \$19\/month/);
  // "today" is resolved for the model but is not reported as an empty day.
  assert.doesNotMatch(context, /Tue 10 Nov 2026: nothing was recorded/);
});

test("'Last Tuesday I asked you about Postgres hosting' finds it by date", () => {
  const { result } = ask(storeWith(POSTGRES, CRM, RECIPE), "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
  assert.equal(result.hits[0]?.turn.id, "pg");
  assert.equal(result.hits[0]?.reason, "asked on Tue 3 Nov 2026");
});

test("'On Monday we shortlisted 5 CRM tools' finds the shortlist", () => {
  const { result, context } = ask(storeWith(POSTGRES, CRM, RECIPE), "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing?");
  assert.equal(result.hits[0]?.turn.id, "crm");
  assert.match(context, /HubSpot, Pipedrive, Salesforce, Zoho CRM and Close/);
});

test("a wrong date still finds the conversation by topic, and says the date was empty", () => {
  // The Postgres question was on Tuesday, not Friday.
  const { result, context } = ask(storeWith(POSTGRES, CRM, RECIPE), "Last Friday I asked you about Postgres hosting. Any changes?");
  assert.match(context, /Fri 6 Nov 2026: nothing was recorded\. Nearest recorded turns: Thu 5 Nov 2026, 18:30 .*; Mon 9 Nov 2026, 10:30/);
  assert.equal(result.topicHits[0]?.id, "pg");
  assert.match(context, /Related by topic, from other dates:/);
});

test("with no history at all, the model is told so instead of being left to guess", () => {
  const { result, context } = ask(new MemoryStore(":memory:"), "What did I ask you on 3 November?");
  assert.equal(result.hits.length, 0);
  assert.match(context, /no earlier conversations are recorded/);
});

test("a date in an ordinary question does not pull old answers into the prompt", () => {
  const { result, context } = ask(storeWith(POSTGRES, CRM), "What happened in the stock market on Monday?");
  assert.equal(result.pointsBack, false);
  assert.equal(result.topicHits.length, 0);
  assert.match(context, /"on Monday" = Mon 9 Nov 2026/);
  assert.doesNotMatch(context, /<past_turn/);
});

test("an ordinary question triggers no memory lookup", () => {
  const { result, context } = ask(storeWith(POSTGRES, CRM), "What is the capital of Australia?");
  assert.equal(result.hits.length, 0);
  assert.equal(context, "Now: Tue 10 Nov 2026, 14:30 (Asia/Kolkata).");
});

test("a turn already in the conversation is pointed at, not repeated", () => {
  const { context } = ask(storeWith(POSTGRES), "What did I ask you on 3 November?", ["pg"]);
  assert.match(context, /this turn is in the current conversation above/);
  assert.doesNotMatch(context, /<past_turn/);
});

test("topic search matches word variants", () => {
  const { result } = ask(storeWith(POSTGRES, RECIPE), "You told me about hosted Postgres prices, remember?");
  assert.equal(result.topicHits[0]?.id, "pg");
});

test("keywords drop filler and date words", () => {
  assert.deepEqual(keywords("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"), [
    "postgres",
    "hosting",
    "pricing",
  ]);
});

test("the timeline lists other conversations and stays fixed for a conversation", () => {
  const store = storeWith(POSTGRES, CRM);
  const current = { id: "now", title: "New", createdAt: NOW, updatedAt: NOW };
  store.createConversation(current);
  const before = renderTimeline(store, current, TZ);
  assert.match(before, /- Tue 3 Nov 2026, 11:30 \| asked: "Which managed Postgres hosting/);
  assert.ok(before.indexOf("Tue 3 Nov") < before.indexOf("Mon 9 Nov"), "oldest first");

  // Turns added after the conversation began do not change its timeline.
  store.saveTurn(turn("later", "2026-11-10T09:05:00Z", "And MySQL?", "PlanetScale.", "now"));
  store.createConversation({ id: "c-other", title: "Other", createdAt: NOW + 1, updatedAt: NOW + 1 });
  store.saveTurn(turn("other", "2026-11-10T09:06:00Z", "Unrelated", "Answer."));
  assert.equal(renderTimeline(store, current, TZ), before);
});
