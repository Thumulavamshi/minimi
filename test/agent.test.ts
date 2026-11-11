import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import type Groq from "groq-sdk";
import { estimateTokens, historyWindow } from "../src/agent/prompt.ts";
import { StreamTranslator, type AgentEvent } from "../src/agent/stream.ts";
import { runTurn, type TurnEvent } from "../src/agent/turn.ts";
import type { Config } from "../src/config.ts";
import { MemoryStore, type Digest, type Turn } from "../src/memory/store.ts";

const CONFIG: Config = { port: 0, model: "test-model", effort: "low", tokenBudget: 8000, digestModel: "test-digest-model", dbPath: ":memory:", hasApiKey: true, debugStream: false };

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
  claims: [{ text: "Neon Launch costs $19/month", source: NEON }],
  volatile: true,
  recheck: "Is Neon Launch still $19/month?",
};

interface Request {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: string }>;
  tools?: unknown;
  max_completion_tokens?: number;
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
  assert.deepEqual(translator.sources, [{ n: 1, url: NEON, title: "Neon Pricing", origin: "search", excerpt: "…" }]);
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
  assert.deepEqual(
    translator.sources.map((s) => [s.n, s.url, s.title]),
    [
      [1, "https://a.com/x", "a.com"],
      [2, "https://b.com/y", "b.com"],
      [3, "https://c.com/z", "the docs"],
    ],
  );
});

test("each cited link is checked against what was actually retrieved", () => {
  const translator = new StreamTranslator(() => {});
  const results = [{ title: "Neon Pricing", url: "https://www.neon.com/pricing/", content: "Launch plan" }];
  translator.handle({ choices: [{ index: 0, delta: { executed_tools: [{ index: 0, type: "search", arguments: "{}", search_results: { results } }] } }] } as never);
  translator.write(
    "Searched [1](https://neon.com/pricing). Remembered [2](https://supabase.com/pricing). Same site [3](https://neon.com/docs). Invented [4](https://example.org/made-up).",
  );
  translator.finish(["https://supabase.com/pricing"]);
  assert.deepEqual(translator.sources.map((s) => s.origin), ["search", "memory", "site", "unlisted"]);
  assert.equal(translator.sources[0]?.excerpt, "Launch plan");
});

test("when searches ran but the API reported no pages, links are left unjudged", () => {
  const translator = new StreamTranslator(() => {});
  translator.handle({ choices: [{ index: 0, delta: { executed_tools: [{ index: 0, type: "search", arguments: '{"query":"x"}' }] } }] } as never);
  translator.write("See [1](https://a.com/x).");
  translator.finish();
  assert.equal(translator.sources[0]?.origin, undefined);
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
  assert.deepEqual(translator.sources, [{ n: 1, url: NEON, title: "Neon Pricing", origin: "search" }]);
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
  assert.match(system, /asked: "What does Neon cost\?" \| answered: Asked for Neon's price; it was \$19\/month\./);
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

test("history keeps the most recent turns that fit the token allowance", () => {
  const turns = Array.from({ length: 6 }, (_, i) => ({ id: String(i), contextNote: "", question: "q".repeat(350), answer: "a".repeat(350), status: "complete" }) as Turn);
  const perTurn = estimateTokens(`<context>\n\n</context>\n\n${"q".repeat(350)}`) + estimateTokens("a".repeat(350));
  assert.deepEqual(historyWindow(turns, perTurn * 2 + 1).map((t) => t.id), ["4", "5"]);
  assert.equal(historyWindow(turns, 10).length, 0);
  assert.equal(historyWindow(turns, 1_000_000).length, 6);
});

test("a request never asks for more tokens than the budget, however long the history", async () => {
  const store = new MemoryStore(":memory:");
  // Thirty earlier conversations with long answers, then a long conversation.
  for (let i = 0; i < 30; i++) {
    store.createConversation({ id: `old-${i}`, title: "old", createdAt: 1000 + i, updatedAt: 1000 + i });
    store.saveTurn({ id: `old-turn-${i}`, conversationId: `old-${i}`, createdAt: 1000 + i, question: `Question ${i} about Postgres hosting prices`, contextNote: "", answer: "Long answer. ".repeat(300), sources: [], searches: [], status: "complete", digest: null, stats: {} });
  }
  const replies = Array.from({ length: 6 }, () => searchReply());
  const { client, requests } = fakeClient(replies);
  let conversationId: string | undefined;
  for (let i = 0; i < 6; i++) {
    const events = await turn(store, client, `You told me about Postgres hosting prices before. ${"More detail please. ".repeat(40)}`, conversationId);
    conversationId = events.find((e) => e.type === "start")!.conversationId;
  }
  for (const request of requests) {
    const prompt = request.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    assert.ok(prompt + request.max_completion_tokens! <= CONFIG.tokenBudget, `request asks for ${prompt + request.max_completion_tokens!} tokens`);
    assert.ok(request.max_completion_tokens! >= 1024);
  }
});
