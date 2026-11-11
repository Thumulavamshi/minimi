# Design

## What the brief is really asking

The sample questions ("What did I ask you on 3 November? Is your answer still correct today?") are not search questions. Each needs a **dated memory** that outlives the session, **exact dates** for phrases like "last Tuesday", and the habit of treating an old answer as **a claim to re-check, not a fact to repeat**. The design is built around those three, under the constraint that the model has exactly one tool.

## How a turn works

```
message → recall (code, ~1 ms) → assemble prompt → model + web search (streamed) → check links → store → summarise (background)
```

1. **Recall** (`src/memory/recall.ts`, `src/time/temporal.ts`). Code resolves each time phrase to a date range in the user's timezone and fetches the turns from those dates. If the message points at the past but the date finds nothing on that topic, a keyword index (SQLite FTS5) searches by topic.
2. **Assemble** (`src/agent/turn.ts`). Fixed instructions, a one-line-per-turn timeline of earlier conversations, this conversation's history, then the new message behind a `<context>` block: the current time, the resolved dates, the recalled turns and their recorded claims.
3. **Answer**. One streamed call to `openai/gpt-oss-120b` on Groq with a single tool, Groq's built-in browser search.
4. **Check and remember** (`src/agent/stream.ts`, `src/memory/`). Every link in the answer is checked against the pages the searches returned. The turn is stored with its timestamp, sources and the exact context it was given. A small model then records the answer's time-sensitive facts as claims, each with its source.

## Decisions

**Memory is context, not a tool.** The brief allows one tool, and a recall tool would cost a model round-trip and depend on the model choosing to call it. A lookup in code takes about a millisecond and cannot be skipped.

**Dates are computed, never inferred.** Models are unreliable at calendar arithmetic, and a wrong date recalls the wrong conversation.

**A record on a date is not proof the user meant that date.** Said on a Thursday, "last Tuesday" has two readings. If only one has records, it is used and named. If both do, the topic decides ("…about Postgres hosting"); if it cannot, both are shown in brief and the model asks.

**Two layers of recall instead of embeddings.** Dates and keywords find turns precisely; the timeline lets the model match loose references itself. At one person's scale this needs no second key or index.

**"Nothing recorded" is a result.** On an empty date the model is told so, with the nearest recorded days and any topic match. Told nothing, a model tends to invent a memory.

**Then versus now, claim by claim.** Memory is authoritative about what was said, never about what is true. A recalled turn arrives with its claims as a numbered list; the model re-searches each and reports changed, unchanged or could not verify.

**Model-written citations are checked, not trusted.** Groq returns search results but not passage-level citations, so the model writes the links. The app labels each one: returned by this answer's search, carried over from a recalled answer, a different page on a searched site, or not in the results at all. It does not claim a page supports a statement; it shows where each link came from.

**Everything is inspectable.** Under each answer: the dates read, turns recalled, claims to re-check, searches run, the link check, and the exact context the model received.

**Speed and size.** No model call runs before the answer starts. Each turn's context block is stored and replayed verbatim, so while a chat's history fits, the prompt before the new message is byte-identical to the previous request (tested), which is what provider-side caching needs; the page shows the cached-token count per answer. Groq's free tier caps a request at 8,000 tokens, so the prompt is budgeted: the reply and recalled memory are reserved first, the timeline gets a fixed slice, and history takes the rest (`TOKEN_BUDGET` raises it).

## Evaluation

`npm run eval` runs 47 scenarios through date reading and recall with no model, so results are exact: **45 / 47** (`eval/recall-results.md`). The two misses are paraphrases sharing no word with the stored turn; the timeline exists for those. Building the set and testing live exposed three bugs, now fixed: a date whose only conversation was off-topic hid the right one, filler words matched unrelated turns, and "still correct today" was read as a second date to look up. `npm run eval:live` asks nine questions of the live model and web and checks behaviour with rules: right day recalled, gaps admitted, no needless searches, links grounded.

## Considered and rejected

- **A model call to route or rewrite each message.** Latency on every turn to help a few.
- **A vector database.** A second key and an index to sync, and less precise than a date.
- **My own search stack.** More control over grounding, but a second key and much more code. First thing I would revisit.
- **A "verified" badge on claims.** It would need the app to fetch and read each page; pricing pages are often script-rendered, so it would fail unpredictably.
- **Re-checking stale answers automatically.** It spends the user's quota unasked. The start screen offers them as one-click prompts.

## With another week

- **Change watch**: re-check recorded claims on a schedule and speak up only when one changed.
- **Page-level verification**: fetch cited pages and confirm the quoted figure appears.
- **A larger live eval** with a second model as grader, and embeddings once history outgrows the timeline.
