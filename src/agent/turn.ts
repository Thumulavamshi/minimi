/**
 * One turn of conversation, end to end:
 *
 *   1. recall   find the past turns the message refers to (code, milliseconds)
 *   2. assemble build the prompt: fixed instructions, timeline, history, context
 *   3. answer   the model replies, searching the web as it sees fit; streamed
 *   4. remember store the turn with its sources, then summarise it in the background
 */
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.ts";
import { writeDigest } from "../memory/digest.ts";
import { recall, renderContext } from "../memory/recall.ts";
import type { Conversation, MemoryStore, Turn, TurnStatus } from "../memory/store.ts";
import { renderTimeline } from "../memory/timeline.ts";
import { formatDateTime, nowMs } from "../time/zoned.ts";
import { assistantContent, historyWindow, SYSTEM_PROMPT, userContent } from "./prompt.ts";
import { StreamTranslator, type AgentEvent } from "./stream.ts";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Message = Anthropic.Beta.Messages.BetaMessage;

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
  client?: Anthropic;
}

/** A long search can pause and need resuming. This bounds how often. */
const MAX_RESUMES = 4;

function titleFrom(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 57)}…`;
}

function explain(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "The Anthropic API key is missing or was rejected. Set ANTHROPIC_API_KEY in .env and restart.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return `This API key is not allowed to do that: ${error.message}`;
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "The model's rate limit was reached. Wait a moment and send the message again.";
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `The model rejected the request: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the model. Check the network connection and try again.";
  }
  if (error instanceof Anthropic.APIError) {
    return `The model service returned an error (${error.status ?? "unknown"}). Try again shortly.`;
  }
  if (error instanceof Error && /authentication|api[_ ]?key|apiKey/i.test(error.message)) {
    return "No Anthropic API key was found. Copy .env.example to .env, set ANTHROPIC_API_KEY, and restart.";
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

  // 2. Assemble. Order matters for caching: the parts that never change come
  //    first, and the only new text in each request is the final user message.
  const timeline = renderTimeline(store, conversation, timezone);
  const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [{ type: "text", text: SYSTEM_PROMPT }];
  if (timeline) system.push({ type: "text", text: timeline });
  system.at(-1)!.cache_control = { type: "ephemeral" };

  const messages: MessageParam[] = history.flatMap((turn): MessageParam[] => [
    { role: "user", content: userContent(turn.contextNote, turn.question) },
    { role: "assistant", content: assistantContent(turn) },
  ]);
  messages.push({ role: "user", content: userContent(contextNote, request.message) });

  // 3. Answer.
  let firstTokenMs: number | undefined;
  const onEvent = (event: AgentEvent): void => {
    if (event.type === "text") firstTokenMs ??= Math.round(performance.now() - clockStart);
    emit(event);
  };
  const stream = new StreamTranslator(onEvent);

  let status: TurnStatus = "complete";
  let final: Message | null = null;
  let failure: string | null = null;

  try {
    const client = deps.client ?? new Anthropic();
    for (let resume = 0; resume <= MAX_RESUMES; resume++) {
      const run = client.beta.messages.stream(
        {
          model: config.model,
          max_tokens: 64_000,
          system,
          messages,
          thinking: { type: "adaptive" },
          output_config: { effort: config.effort },
          tools: [
            {
              type: "web_search_20260209",
              name: "web_search",
              max_uses: config.maxSearches,
              // Lets search favour results for where the user is.
              user_location: { type: "approximate", timezone },
            },
          ],
          // Caches the conversation so far; the next turn re-reads it cheaply.
          cache_control: { type: "ephemeral" },
          ...(config.refusalFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: request.signal },
      );
      for await (const event of run) stream.handle(event);
      final = await run.finalMessage();

      // The search loop runs on the API's side and can stop part-way through a
      // long turn. Sending its partial reply back makes it carry on.
      if (final.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: final.content });
    }

    if (final?.stop_reason === "refusal" && !stream.answer.trim()) {
      stream.write("I can't help with that request.");
    } else if (final?.stop_reason === "max_tokens") {
      status = "interrupted";
    }
  } catch (error) {
    if (request.signal.aborted || error instanceof Anthropic.APIUserAbortError) {
      status = "interrupted";
    } else {
      status = "error";
      failure = explain(error);
    }
  }

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
      model: final?.model ?? config.model,
      totalMs: Math.round(performance.now() - clockStart),
      firstTokenMs,
      inputTokens: final?.usage.input_tokens,
      outputTokens: final?.usage.output_tokens,
      cachedTokens: final?.usage.cache_read_input_tokens ?? undefined,
    },
  };
  store.saveTurn(turn);
  if (failure) emit({ type: "error", message: failure });
  emit({ type: "done", turn });

  // Summarise in the background. The user is not waiting on this.
  if (turn.status === "complete") {
    const isFirstTurn = earlier.length === 0;
    void writeDigest(deps.client ?? new Anthropic(), config.digestModel, turn, timezone)
      .then((digest) => {
        if (!digest) return;
        store.setDigest(turn.id, digest);
        if (isFirstTurn) store.renameConversation(turn.conversationId, digest.title);
      })
      .catch((error: unknown) => console.warn(`[digest] skipped for turn ${turn.id}: ${explain(error)}`));
  }
}
