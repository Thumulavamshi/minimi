/**
 * One turn of conversation, end to end:
 *
 *   1. recall   find the past turns the message refers to (code, milliseconds)
 *   2. assemble build the prompt: fixed instructions, timeline, history, context
 *   3. answer   the model replies, searching the web as it sees fit; streamed
 *   4. remember store the turn with its sources, then summarise it in the background
 */
import { randomUUID } from "node:crypto";
import Groq from "groq-sdk";
import type { Config } from "../config.ts";
import { writeDigest } from "../memory/digest.ts";
import { recall, renderContext } from "../memory/recall.ts";
import type { Conversation, MemoryStore, Turn, TurnStatus } from "../memory/store.ts";
import { renderTimeline } from "../memory/timeline.ts";
import { formatDateTime, nowMs } from "../time/zoned.ts";
import { assistantContent, historyWindow, SYSTEM_PROMPT, userContent } from "./prompt.ts";
import { StreamTranslator, type AgentEvent } from "./stream.ts";

type MessageParam = Groq.Chat.Completions.ChatCompletionMessageParam;

/** What the server sends to the browser while a turn runs. */
export type TurnEvent =
  | AgentEvent
  | {
      type: "start";
      conversationId: string;
      /** The dates the app read out of the message. */
      dates: Array<{ phrase: string; label: string }>;
      /** The past turns handed to the model. */
      recalled: Array<{ when: string; question: string; reason: string }>;
    }
  | { type: "done"; turn: Turn }
  | { type: "error"; message: string };

export interface TurnRequest {
  conversationId?: string;
  message: string;
  timezone: string;
  signal: AbortSignal;
  emit: (event: TurnEvent) => void;
}

export interface TurnDeps {
  store: MemoryStore;
  config: Config;
  /** Supplied by tests; otherwise created from the environment. */
  client?: Groq;
}

function titleFrom(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 57)}…`;
}

function explain(error: unknown): string {
  if (error instanceof Groq.AuthenticationError) {
    return "The Groq API key is missing or was rejected. Set GROQ_API_KEY in .env and restart.";
  }
  if (error instanceof Groq.PermissionDeniedError) {
    return `This API key is not allowed to do that: ${error.message}`;
  }
  if (error instanceof Groq.RateLimitError) {
    return `Groq's rate limit was reached (the free tier allows only a few thousand tokens a minute). Wait a minute and send the message again. Details: ${error.message}`;
  }
  if (error instanceof Groq.NotFoundError) {
    // Groq answers 404 when the model name is unknown or the key has no access to it.
    return `Groq could not find what was requested: ${error.message}. Check AGENT_MODEL and DIGEST_MODEL in .env (the default answering model is "openai/gpt-oss-120b").`;
  }
  if (error instanceof Groq.BadRequestError) {
    return `The model rejected the request: ${error.message}`;
  }
  if (error instanceof Groq.APIConnectionError) {
    return "Could not reach the model. Check the network connection and try again.";
  }
  if (error instanceof Groq.APIError) {
    return `Groq returned an error (${error.status ?? "unknown"}): ${error.message}`;
  }
  if (error instanceof Error && /GROQ_API_KEY|api[_ ]?key|apiKey/i.test(error.message)) {
    return "No Groq API key was found. Copy .env.example to .env, set GROQ_API_KEY, and restart.";
  }
  return error instanceof Error ? error.message : String(error);
}

export async function runTurn(deps: TurnDeps, request: TurnRequest): Promise<void> {
  const { store, config } = deps;
  const { emit, timezone } = request;
  const startedAt = nowMs();
  const clockStart = performance.now();

  // A conversation that does not exist yet is created by its first message.
  let conversation: Conversation | null = request.conversationId ? store.getConversation(request.conversationId) : null;
  if (!conversation) {
    conversation = { id: randomUUID(), title: titleFrom(request.message), createdAt: startedAt, updatedAt: startedAt };
    store.createConversation(conversation);
  }
  const earlier = store.turnsInConversation(conversation.id);
  const history = historyWindow(earlier);

  // 1. Recall.
  const recallInput = {
    message: request.message,
    nowMs: startedAt,
    timezone,
    inContext: new Set(history.map((t) => t.id)),
  };
  const recalled = recall(store, recallInput);
  const contextNote = renderContext(recalled, recallInput);
  emit({
    type: "start",
    conversationId: conversation.id,
    dates: recalled.refs.map((ref) => ({ phrase: ref.phrase, label: ref.candidates[0]!.label })),
    recalled: recalled.hits.map((hit) => ({
      when: formatDateTime(hit.turn.createdAt, timezone),
      question: hit.turn.question,
      reason: hit.reason,
    })),
  });

  // 2. Assemble. The parts that never change come first, and the only new text
  //    in each request is the final user message. Groq caches a repeated
  //    prompt prefix automatically on models that support it, so a stable
  //    prefix makes follow-up turns cheaper and faster.
  const timeline = renderTimeline(store, conversation, timezone);
  const messages: MessageParam[] = [
    { role: "system", content: timeline ? `${SYSTEM_PROMPT}\n\n${timeline}` : SYSTEM_PROMPT },
    ...history.flatMap((turn): MessageParam[] => [
      { role: "user", content: userContent(turn.contextNote, turn.question) },
      { role: "assistant", content: assistantContent(turn) },
    ]),
    { role: "user", content: userContent(contextNote, request.message) },
  ];

  // 3. Answer.
  let firstTokenMs: number | undefined;
  const stream = new StreamTranslator((event) => {
    if (event.type === "text") firstTokenMs ??= Math.round(performance.now() - clockStart);
    emit(event);
  });

  let status: TurnStatus = "complete";
  let failure: string | null = null;
  let servedBy = config.model;
  let usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number } | null } | undefined;

  try {
    const client = deps.client ?? new Groq();
    const run = await client.chat.completions.create(
      {
        model: config.model,
        messages,
        stream: true,
        // Kept modest: the free tier counts requested output against a small per-minute budget.
        max_completion_tokens: 4096,
        reasoning_effort: config.effort,
        // The one tool. Groq runs it on its side; "auto" leaves the model free
        // to answer from memory or general knowledge without searching.
        tools: [{ type: "browser_search" }],
        tool_choice: "auto",
      },
      { signal: request.signal },
    );
    for await (const chunk of run) {
      if (config.debugStream && chunk.choices[0]?.delta.executed_tools) {
        console.log("[stream]", JSON.stringify(chunk.choices[0].delta.executed_tools).slice(0, 1500));
      }
      stream.handle(chunk);
      servedBy = chunk.model || servedBy;
      usage = chunk.x_groq?.usage ?? usage;
      if (chunk.choices[0]?.finish_reason === "length") status = "interrupted";
    }
  } catch (error) {
    if (request.signal.aborted || error instanceof Groq.APIUserAbortError) {
      status = "interrupted";
    } else {
      status = "error";
      failure = explain(error);
      console.error(`[turn] ${config.model} failed:`, error);
    }
  }
  stream.finish();

  // 4. Remember. A turn with no answer text is not worth remembering.
  if (!stream.answer.trim()) {
    if (earlier.length === 0) store.deleteConversation(conversation.id);
    emit({ type: "error", message: failure ?? "The reply was stopped before it began." });
    return;
  }

  const turn: Turn = {
    id: randomUUID(),
    conversationId: conversation.id,
    createdAt: startedAt,
    question: request.message,
    contextNote,
    answer: stream.answer,
    sources: stream.sources,
    searches: stream.searches,
    status: status === "error" ? "interrupted" : status,
    digest: null,
    stats: {
      model: servedBy,
      totalMs: Math.round(performance.now() - clockStart),
      firstTokenMs,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
    },
  };
  store.saveTurn(turn);
  if (failure) emit({ type: "error", message: failure });
  emit({ type: "done", turn });

  // Summarise in the background. The user is not waiting on this.
  if (turn.status === "complete") {
    const isFirstTurn = earlier.length === 0;
    void Promise.resolve()
      .then(() => writeDigest(deps.client ?? new Groq(), config.digestModel, turn, timezone))
      .then((digest) => {
        if (!digest) return;
        store.setDigest(turn.id, digest);
        if (isFirstTurn) store.renameConversation(turn.conversationId, digest.title);
      })
      .catch((error: unknown) => console.warn(`[digest] skipped for turn ${turn.id}: ${explain(error)}`));
  }
}
