import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { historyWindow } from "../src/agent/prompt.ts";
import { StreamTranslator, type AgentEvent } from "../src/agent/stream.ts";
import { runTurn, type TurnEvent } from "../src/agent/turn.ts";
import type { Config } from "../src/config.ts";
import { MemoryStore, type Digest, type Turn } from "../src/memory/store.ts";

const CONFIG: Config = {
  port: 0,
  model: "test-model",
  effort: "medium",
  digestModel: "test-digest-model",
  maxSearches: 8,
  refusalFallback: true,
  dbPath: ":memory:",
  hasApiKey: true,
};

const NEON = "https://neon.com/pricing";

/** The events of one reply that searches once and cites one page. */
function searchReply(): unknown[] {
  const start = (index: number, content_block: object) => ({ type: "content_block_start", index, content_block });
  const delta = (index: number, d: object) => ({ type: "content_block_delta", index, delta: d });
  const stop = (index: number) => ({ type: "content_block_stop", index });
  return [
    { type: "message_start" },
    start(0, { type: "thinking", thinking: "" }),
    stop(0),
    start(1, { type: "server_tool_use", id: "t1", name: "web_search", input: {} }),
    delta(1, { type: "input_json_delta", partial_json: '{"query":"neon ' }),
    delta(1, { type: "input_json_delta", partial_json: 'pricing 2026"}' }),
    stop(1),
    start(2, {
      type: "web_search_tool_result",
      tool_use_id: "t1",
      content: [{ type: "web_search_result", url: NEON, title: "Neon Pricing", encrypted_content: "x", page_age: null }],
    }),
    stop(2),
    start(3, { type: "text", text: "" }),
    delta(3, { type: "text_delta", text: "Neon Launch is " }),
    stop(3),
    start(4, { type: "text", text: "" }),
    delta(4, {
      type: "citations_delta",
      citation: { type: "web_search_result_location", url: NEON, title: "Neon Pricing", cited_text: "…", encrypted_index: "i" },
    }),
    delta(4, { type: "text_delta", text: "$19/month" }),
    stop(4),
    start(5, { type: "text", text: "" }),
    delta(5, { type: "text_delta", text: "." }),
    stop(5),
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

interface Script {
  events: unknown[];
  stop_reason: string;
}

/** A stand-in for the Anthropic client that replays scripted replies and records each request. */
function fakeClient(scripts: Script[]) {
  const requests: Array<{ system: Array<{ text: string }>; messages: Array<{ role: string; content: unknown }>; tools: unknown[] }> = [];
  const client = {
    beta: {
      messages: {
        stream(params: unknown) {
          requests.push(structuredClone(params) as (typeof requests)[number]);
          const script = scripts.shift()!;
          return {
            async *[Symbol.asyncIterator]() {
              yield* script.events;
            },
            finalMessage: async () => ({
              model: "test-model",
              stop_reason: script.stop_reason,
              content: [{ type: "text", text: "partial" }],
              usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
            }),
          };
        },
      },
    },
    messages: { parse: async () => ({ parsed_output: DIGEST }) },
  } as unknown as Anthropic;
  return { client, requests };
}

async function turn(store: MemoryStore, client: Anthropic, message: string, conversationId?: string) {
  const events: TurnEvent[] = [];
  await runTurn(
    { store, config: CONFIG, client },
    { message, conversationId, timezone: "Asia/Kolkata", signal: new AbortController().signal, emit: (e) => events.push(e) },
  );
  await tick(); // let the background digest finish
  return events;
}

test("the stream translator yields text, activity, and numbered citations", () => {
  const events: AgentEvent[] = [];
  const translator = new StreamTranslator((e) => events.push(e));
  for (const event of searchReply()) translator.handle(event as never);

  assert.equal(translator.answer, `Neon Launch is $19/month [1](${NEON}).`);
  assert.deepEqual(translator.sources, [{ n: 1, url: NEON, title: "Neon Pricing" }]);
  assert.deepEqual(translator.searches, ["neon pricing 2026"]);
  assert.deepEqual(
    events.filter((e) => e.type === "activity"),
    [
      { type: "activity", kind: "thinking" },
      { type: "activity", kind: "searching" },
      { type: "activity", kind: "searching", detail: "neon pricing 2026" },
      { type: "activity", kind: "reading", detail: "neon.com" },
    ],
  );
});

test("a page cited twice keeps one number, and a failed search is reported", () => {
  const events: AgentEvent[] = [];
  const translator = new StreamTranslator((e) => events.push(e));
  const cite = { type: "web_search_result_location", url: "https://a.com/x_(y)", title: null, cited_text: "", encrypted_index: "" };
  const feed = [
    { type: "content_block_start", index: 0, content_block: { type: "web_search_tool_result", tool_use_id: "t", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: cite } },
    { type: "content_block_delta", index: 1, delta: { type: "citations_delta", citation: cite } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "A" } },
    { type: "content_block_stop", index: 1 },
  ];
  for (const event of feed) translator.handle(event as never);
  assert.equal(translator.answer, "A [1](https://a.com/x_%28y%29)");
  assert.equal(translator.sources[0]?.title, "a.com");
  assert.deepEqual(events[0], { type: "activity", kind: "search_failed", detail: "too_many_requests" });
});

test("a turn is answered, stored with its sources, and summarised afterwards", async () => {
  const store = new MemoryStore(":memory:");
  const { client, requests } = fakeClient([{ events: searchReply(), stop_reason: "end_turn" }]);
  const events = await turn(store, client, "What does Neon cost?");

  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  const saved = store.getTurn(done.turn.id)!;
  assert.equal(saved.answer, `Neon Launch is $19/month [1](${NEON}).`);
  assert.equal(saved.sources.length, 1);
  assert.deepEqual(saved.digest, DIGEST);
  assert.equal(store.getConversation(saved.conversationId)?.title, "Neon pricing");

  const request = requests[0]!;
  assert.deepEqual(request.tools, [
    { type: "web_search_20260209", name: "web_search", max_uses: 8, user_location: { type: "approximate", timezone: "Asia/Kolkata" } },
  ]);
  assert.equal(request.tools.length, 1, "the model has exactly one tool");
  assert.match(String(request.messages.at(-1)?.content), /^<context>\nNow: .*\nMemory: no earlier conversations are recorded/);
});

test("a follow-up replays the earlier turn exactly as the model first saw it", async () => {
  const store = new MemoryStore(":memory:");
  const { client, requests } = fakeClient([
    { events: searchReply(), stop_reason: "end_turn" },
    { events: searchReply(), stop_reason: "end_turn" },
  ]);
  const first = await turn(store, client, "What does Neon cost?");
  const conversationId = first.find((e) => e.type === "start")!.conversationId;
  await turn(store, client, "And Supabase?", conversationId);

  const [one, two] = requests;
  // The earlier request's messages are a prefix of the later one: that is what keeps the cache valid.
  assert.deepEqual(two!.messages[0], one!.messages[0]);
  assert.deepEqual(two!.messages[1], { role: "assistant", content: `Neon Launch is $19/month [1](${NEON}).` });
  assert.equal(two!.messages.length, 3);
  assert.deepEqual(two!.system, one!.system, "the system prompt does not change within a conversation");
});

test("a new conversation sees earlier ones through the timeline", async () => {
  const store = new MemoryStore(":memory:");
  const { client, requests } = fakeClient([
    { events: searchReply(), stop_reason: "end_turn" },
    { events: searchReply(), stop_reason: "end_turn" },
  ]);
  await turn(store, client, "What does Neon cost?");
  await turn(store, client, "Hello again");
  const system = requests[1]!.system.map((block) => block.text).join("\n");
  assert.match(system, /<earlier_conversations>/);
  assert.match(system, /stated then: Neon Launch costs \$19\/month/);
});

test("a paused search is resumed by sending the partial reply back", async () => {
  const store = new MemoryStore(":memory:");
  const { client, requests } = fakeClient([
    { events: searchReply().slice(0, 9), stop_reason: "pause_turn" },
    { events: searchReply().slice(9), stop_reason: "end_turn" },
  ]);
  const events = await turn(store, client, "What does Neon cost?");
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.messages.at(-1)?.role, "assistant");
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.turn.answer, `Neon Launch is $19/month [1](${NEON}).`);
});

test("a failure before any text leaves nothing behind", async () => {
  const store = new MemoryStore(":memory:");
  const client = {
    beta: { messages: { stream: () => { throw new Error("network down"); } } },
  } as unknown as Anthropic;
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
