/**
 * After an answer is finished, a small model writes a short index card for it:
 * a title, a summary, the names involved, and the specific facts that could
 * change. The card feeds the timeline, improves keyword recall, and marks
 * which answers are worth re-checking later.
 *
 * This runs after the user already has their answer, so it adds nothing to
 * response time. If it fails, the turn is still stored and still found by date
 * and by its own words.
 */
import type Groq from "groq-sdk";
import { z } from "zod";
import { formatDateTime } from "../time/zoned.ts";
import type { Digest, Turn } from "./store.ts";

/** The model is asked for JSON; this checks that what came back has the right shape. */
const DigestSchema = z.object({
  title: z.string(),
  summary: z.string(),
  entities: z.array(z.string()),
  // Small models sometimes return a bare string for a claim; accept that too.
  claims: z.array(z.union([z.string(), z.object({ text: z.string(), source: z.string().nullable().optional() })])),
  volatile: z.boolean(),
  recheck: z.string().nullable(),
});

const INSTRUCTIONS = `You write index cards for an assistant's long-term memory. Each card describes one finished exchange between a user and the assistant, so that the exchange can be found and re-checked weeks later. Record only what the exchange says. Copy figures exactly, with their units.

Reply with one JSON object and nothing else, with these keys:
- "title": a title for the exchange, at most 6 words, with no date.
- "summary": one or two sentences: what the user wanted and what the answer concluded.
- "entities": an array of the products, companies, people and places named (at most 12).
- "claims": an array of the specific facts from the answer that could change with time (at most 8; empty if none). Each is an object with "text", the fact standing alone, e.g. "Supabase Pro costs $25/month", and "source", the URL of the link the answer cites for that fact, or null if it cites none.
- "volatile": true if the answer depends on prices, versions, availability, news or anything else that goes stale; otherwise false.
- "recheck": if volatile, a question the user could ask later to re-verify the answer, phrased as they would ask it; otherwise null.`;

export async function writeDigest(client: Groq, model: string, turn: Turn, timezone: string): Promise<Digest | null> {
  if (!turn.answer.trim()) return null;
  const response = await client.chat.completions.create({
    model,
    max_completion_tokens: 2000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: INSTRUCTIONS },
      {
        role: "user",
        content: `Exchange from ${formatDateTime(turn.createdAt, timezone)}.\n\n<user>\n${turn.question}\n</user>\n\n<assistant>\n${turn.answer.slice(0, 12_000)}\n</assistant>`,
      },
    ],
  });
  const parsed = DigestSchema.safeParse(JSON.parse(response.choices[0]?.message.content ?? "null"));
  if (!parsed.success) return null;
  // A claim may only point at a page the answer really cited.
  const cited = new Set(turn.sources.map((s) => s.url));
  const claims = parsed.data.claims.map((c) => {
    const claim = typeof c === "string" ? { text: c, source: null } : c;
    return { text: claim.text, source: claim.source && cited.has(claim.source) ? claim.source : null };
  });
  return { ...parsed.data, claims };
}
