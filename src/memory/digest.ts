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
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { formatDateTime } from "../time/zoned.ts";
import type { Digest, Turn } from "./store.ts";

const DigestSchema = z.object({
  title: z.string().describe("A title for this exchange, at most 6 words, with no date."),
  summary: z.string().describe("One or two sentences: what the user wanted and what the answer concluded."),
  entities: z.array(z.string()).describe("Products, companies, people and places named. At most 12."),
  claims: z
    .array(z.string())
    .describe(
      "Specific facts from the answer that could change with time, each standing alone, e.g. 'Supabase Pro costs $25/month'. At most 8. Empty if there are none.",
    ),
  volatile: z.boolean().describe("True if the answer depends on prices, versions, availability, news or anything else that goes stale."),
  recheck: z
    .string()
    .nullable()
    .describe("If volatile: a question the user could ask later to re-verify this answer, phrased as they would ask it. Otherwise null."),
});

const INSTRUCTIONS = `You write index cards for an assistant's long-term memory. Each card describes one finished exchange between a user and the assistant, so that the exchange can be found and re-checked weeks later. Record only what the exchange says. Copy figures exactly, with their units.`;

export async function writeDigest(client: Anthropic, model: string, turn: Turn, timezone: string): Promise<Digest | null> {
  if (!turn.answer.trim()) return null;
  const response = await client.messages.parse({
    model,
    max_tokens: 4000,
    system: INSTRUCTIONS,
    output_config: { effort: "low", format: zodOutputFormat(DigestSchema) },
    messages: [
      {
        role: "user",
        content: `Exchange from ${formatDateTime(turn.createdAt, timezone)}.\n\n<user>\n${turn.question}\n</user>\n\n<assistant>\n${turn.answer.slice(0, 12_000)}\n</assistant>`,
      },
    ],
  });
  return response.parsed_output ?? null;
}
