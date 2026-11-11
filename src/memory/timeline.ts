/**
 * A one-line-per-turn history of earlier conversations, placed in the system
 * prompt.
 *
 * Recall (recall.ts) finds turns by date and by keyword. That misses loose
 * references such as "the database thing we looked at". Rather than add an
 * embedding index, the model is shown a short dated list of recent turns and
 * does the matching itself, which it is good at. For one person's history the
 * list is small, and it sits in the cached part of the prompt.
 *
 * The list is fixed when a conversation starts and holds only turns from
 * other conversations. It therefore stays byte-identical for the life of the
 * conversation, so the prompt cache keeps hitting; this conversation's own
 * turns are already present as message history.
 */
import { formatDateTime } from "../time/zoned.ts";
import type { Conversation, MemoryStore, Turn } from "./store.ts";

const TIMELINE_TURNS = 60;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

export function timelineLine(turn: Turn, timezone: string): string {
  const when = formatDateTime(turn.createdAt, timezone);
  const digest = turn.digest;
  if (!digest) {
    // The digest is written just after the answer. Until then, fall back to the raw text.
    return `- ${when} | asked: "${clip(turn.question, 160)}" | answered: ${clip(turn.answer, 220) || "(no answer recorded)"}`;
  }
  const facts = digest.claims.length ? ` | stated then: ${digest.claims.map((c) => clip(c.text, 140)).join("; ")}` : "";
  return `- ${when} | asked: "${clip(turn.question, 160)}" | answered: ${clip(digest.summary, 300)}${facts}`;
}

export function renderTimeline(store: MemoryStore, conversation: Conversation, timezone: string): string {
  const turns = store.turnsBefore(conversation.createdAt, conversation.id, TIMELINE_TURNS);
  if (turns.length === 0) return "";
  return [
    "<earlier_conversations>",
    `Summaries of the user's ${turns.length} most recent earlier turns with you, oldest first. Times are in ${timezone}.`,
    "Each line records what was said at the time. Prices, versions and other facts may have changed since.",
    ...turns.map((turn) => timelineLine(turn, timezone)),
    "</earlier_conversations>",
  ].join("\n");
}
