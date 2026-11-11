import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import type Groq from "groq-sdk";
import { historyWindow } from "../src/agent/prompt.ts";
import { StreamTranslator, type AgentEvent } from "../src/agent/stream.ts";
import { runTurn, type TurnEvent } from "../src/agent/turn.ts";
import type { Config } from "../src/config.ts";
import { MemoryStore, type Digest, type Turn } from "../src/memory/store.ts";

const CONFIG: Config = { port: 0, model: "test-model", effort: "low", digestModel: "test-digest-model", dbPath: ":memory:", hasApiKey: true, debugStream: false };

const NEON = "https://neon.com/pricing";
const ANSWER = `Neon Launch is $19/month [1](${NEON}).`;

/** The chunks of one reply that thinks, searches once, and cites one page. */
function searchReply(): unknown[] {
  const chunk = (delta: object, extra: object = {}) => ({ model: "test-model", choices: [{ index: 0, delta, finish_reason: null }], ...extra });
  const search = { index: 0, type: "search", arguments: '{"query":"neon pricing 2026"}' };
  return [
    chunk({ role: "assistant", reasoning: "The user wants a price." }),
    chunk({ executed_tools: [search] }),
    chunk({ executed_tools: [{ ...search, search_results: { results: [{ title: "Neon Pricing", url: NEON, content: "…", score: 0.9 }] } }] }),
    chunk({ content: "Neon Launch is " }),
    chunk({ content: `$19/month [1](${NEON}).` }),
    {
      model: "test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      x_groq: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    },
  ];
}

const DIGEST: Digest = {
  title: "Neon pricing",
  summary: "Asked for Neon's price; it was $19/month.",
  entities: ["Neon"],
  claims: ["Neon Launch costs $19/month"],
  volatile: true,
  recheck: "Is Neon Launch still $19/month?",
};

interface Request {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: string }>;
  tools?: unknown;
}

/** A stand-in for the Groq client that replays scripted replies and records each chat request. */
function fakeClient(replies: unknown[][], digest: unknown = DIGEST) {
  const requests: Request[] = [];
  const client = {
    chat: {
      completions: {
        async create(params: Request) {
          if (!params.stream) return { choices: [{ message: { content: JSON.stringify(digest) } }] };
          requests.push(structuredClone(params));
          const chunks = replies.shift()!;
          return {
            async *[Symbol.asyncIterator]() {
              yield* chunks;
            },
          };
        },
      },
    },
  } as unknown as Groq;
  return { client, requests };
}

async function turn(store: MemoryStore, client: Groq, message: string, conversationId?: string) {
  const events: TurnEvent[] = [];
  await runTurn(
    { store, config: CONFIG, client },
    { message, conversationId, timezone: "Asia/Kolkata", signal: new AbortController().signal, emit: (e) => events.push(e) },
  );
  await tick(); // let the background digest finish
  await tick();
  return events;
}

test("the stream translator yields text, activity, and sources read from the citations", () => {
  const events: AgentEvent[] = [];
  const translator = new StreamTranslator((e) => events.push(e));
  for (const chunk of searchReply()) translator.handle(chunk as never);
  translator.finish();

  assert.equal(translator.answer, ANSWER);
  assert.deepEqual(translator.sources, [{ n: 1, url: NEON, title: "Neon Pricing" }]);
  assert.deepEqual(translator.searches, ["neon pricing 2026"]);
  assert.deepEqual(
    events.filter((e) => e.type === "activity"),
    [
      { type: "activity", kind: "thinking" },
      { type: "activity", kind: "searching", detail: "neon pricing 2026" },
      { type: "activity", kind: "reading", detail: "neon.com" },
    ],
  );
});

test("each cited page is listed once, in order, with the best title available", () => {
  const translator = new StreamTranslator(() => {});
  translator.write("A [1](https://a.com/x). B [2](https://b.com/y). A again [1](https://a.com/x). See [the docs](https://c.com/z).");
  translator.finish();
  assert.deepEqual(translator.sources, [
    { n: 1, url: "https://a.com/x", title: "a.com" },
    { n: 2, url: "https://b.com/y", title: "b.com" },
    { n: 3, url: "https://c.com/z", title: "the docs" },
  ]);
});

test("the model's own bracket marks are removed, even when split across chunks", () => {
  const translator = new StreamTranslator(() => {});
  const chunk = (content: string) => ({ choices: [{ index: 0, delta: { content } }] });
  for (const piece of ["Neon costs $19【4†L10", "-L12】 a month. 【", "5†L1】Done."]) translator.handle(chunk(piece) as never);
  translator.finish();
  assert.equal(translator.answer, "Neon costs $19 a month. Done.");
});

test("an answer with no links still lists the pages that were searched", () => {
  const translator = new StreamTranslator(() => {});
  const tool = { index: 0, type: "browser_search", arguments: 'browser.search(query="neon pricing")', search_results: { results: [{ title: "Neon Pricing", url: NEON }] } };
  translator.handle({ choices: [{ index: 0, delta: { executed_tools: [tool] } }] } as never);
  translator.handle({ choices: [{ index: 0, delta: { content: "Neon Launch is $19/month." } }] } as never);
  translator.finish();
  assert.deepEqual(translator.searches, ["neon pricing"]);
  assert.deepEqual(translator.sources, [{ n: 1, url: NEON, title: "Neon Pricing" }]);
});

test("a turn is answered, stored with its sources, and summarised afterwards", async () => {
  const store = new MemoryStore(":memory:");
  const { client, requests } = fakeClient([searchReply()]);
  const events = await turn(store, client, "What does Neon cost?");

  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  const saved = store.getTurn(done.turn.id)!;
  assert.equal(saved.answer, ANSWER);
  assert.equal(saved.sources.length, 1);
  assert.deepEqual(saved.digest, DIGEST);
  assert.equal(store.getConversation(saved.conversationId)?.title, "Neon pricing");

  const request = requests[0]!;
  assert.deepEqual(request.tools, [{ type: "browser_search" }], "the model has exactly one tool: web search");
  assert.equal(request.messages[0]?.role, "system");
  assert.match(request.messages.at(-1)!.content, /^<context>\nNow: .*\nMemory: no earlier conversations are recorded/);
});

test("a follow-up replays the earlier turn exactly as the model first saw it", async () => {
  const store = new MemoryStore(":memory:");
  const { client, requests } = fakeClient([searchReply(), searchReply()]);
  const first = await turn(store, client, "What does Neon cost?");
  const conversationId = first.find((e) => e.type === "start")!.conversationId;
  await turn(store, client, "And Supabase?", conversationId);

  const [one, two] = requests;
  // The earlier request's messages are a prefix of the later one: that is what keeps the cache valid.
  assert.deepEqual(two!.messages.slice(0, 2), one!.messages, "system prompt and first question are unchanged");
  assert.deepEqual(two!.messages[2], { role: "assistant", content: ANSWER });
  assert.equal(two!.messages.length, 4);
});

test("a new conversation sees earlier ones through the timeline", async () => {
  const store = new MemoryStore(":memory:");
  const { client, requests } = fakeClient([searchReply(), searchReply()]);
  await turn(store, client, "What does Neon cost?");
  await turn(store, client, "Hello again");
  const system = requests[1]!.messages[0]!.content;
  assert.match(system, /<earlier_conversations>/);
  assert.match(system, /stated then: Neon Launch costs \$19\/month/);
});

test("a summary that comes back malformed is dropped, and the turn is still stored", async () => {
  const store = new MemoryStore(":memory:");
  const { client } = fakeClient([searchReply()], { title: "only a title" });
  const events = await turn(store, client, "What does Neon cost?");
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(store.getTurn(done.turn.id)?.digest, null);
  assert.equal(store.getTurn(done.turn.id)?.answer, ANSWER);
});

test("a failure before any text leaves nothing behind", async () => {
  const store = new MemoryStore(":memory:");
  const client = {
    chat: { completions: { create: async () => { throw new Error("network down"); } } },
  } as unknown as Groq;
  const events = await turn(store, client, "Hello");
  assert.deepEqual(events.at(-1), { type: "error", message: "network down" });
  assert.equal(store.countTurns(), 0);
  assert.equal(store.listConversations().length, 0);
});

test("long conversations replay a window whose start moves in steps", () => {
  const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }) as Turn);
  assert.equal(historyWindow(turns(40)).length, 40);
  assert.equal(historyWindow(turns(41))[0]?.id, "10");
  assert.equal(historyWindow(turns(49))[0]?.id, "10", "unchanged for ten turns");
  assert.equal(historyWindow(turns(50))[0]?.id, "20");
});
