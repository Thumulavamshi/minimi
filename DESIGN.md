# Design

## What the brief is really asking

The three sample questions are not search questions:

- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
- "On Monday we shortlisted 5 CRM tools… Has any of them changed pricing since?"

Each needs three things a plain search agent lacks: a **dated memory** that outlives the session, **exact dates** for phrases like "last Tuesday", and the habit of treating an old answer as **a claim to re-check, not a fact to repeat**. The design is built around those three, under the brief's constraint that the model has exactly one tool.

## How a turn works

```
message → recall (code, <1 ms) → assemble prompt → model + web search (streamed) → store turn → digest (background)
```

1. **Recall** (`src/memory/recall.ts`, `src/time/temporal.ts`). Code resolves every time phrase to a date range in the user's timezone, then looks up turns from those dates. If the message points at the past but the date finds nothing, a keyword index (SQLite FTS5) searches by topic.
2. **Assemble** (`src/agent/turn.ts`). The prompt is: fixed instructions, a one-line-per-turn timeline of earlier conversations, this conversation's history, then the new message behind a `<context>` block holding the current time, the resolved dates and the recalled turns.
3. **Answer**. One streamed model call. The model decides whether to search; citations are written into the answer as numbered links.
4. **Remember** (`src/memory/store.ts`, `digest.ts`). The turn is stored with its timestamp, sources and the exact context it was given. A small model then writes a summary card (title, entities, facts that could change) in the background.

## Decisions

**Memory is context, not a tool.** The brief allows one tool. More importantly, a recall tool costs a model round-trip and depends on the model choosing to call it. Looking memory up in code first is faster (0.5 ms over 2,000 turns) and cannot be forgotten.

**Dates are computed, never inferred.** Models are unreliable at calendar arithmetic, and a wrong date recalls the wrong conversation. Ambiguity is kept rather than guessed: said on a Thursday, "last Tuesday" resolves to both candidate Tuesdays and the lookup uses whichever has a record.

**Two layers of recall instead of embeddings.** Dates and keywords find turns precisely; the timeline lets the model match loose references ("the database thing") itself. At one person's scale that beats cosine similarity and needs no second API key or index.

**"Nothing recorded" is a result.** On an empty date the model is told so, with the nearest recorded days and any topic match. Told nothing, a model tends to invent a memory. Ask about the wrong day and it answers "nothing on Friday, but on Tuesday you asked…".

**Then versus now.** Memory is authoritative about what was said, never about what is true. The prompt makes the model restate the old claim, re-search each part at its primary source, and report changed / unchanged / could not verify.

**Speed.** No model call runs before the answer starts. The prompt is ordered so everything before the new message is byte-identical to the previous request and served from cache; that is why each turn's context block is stored and replayed verbatim. Search results are not replayed in later turns; the answer and its links are.

**One key.** Claude's built-in web search means one API key and one streamed request, with citations tied to the passages they support.

## Considered and rejected

- **A model call to route or rewrite each message.** Adds latency to every turn to save tokens on a few.
- **A vector database.** A second key, an index to keep in sync, and worse precision than a date for "on 3 November".
- **My own search stack (search API + page fetcher + reranker).** More code and a second key, without better grounding than the built-in tool.
- **An agent framework.** The loop is about 200 lines; a framework would hide the prompt assembly, which is the design.
- **Re-checking stale answers automatically.** It spends the user's money unasked. The start screen instead offers stale answers as one-click prompts.

## With another week

- **A graded eval set**: scripted histories replayed with a simulated clock (`AGENT_NOW` exists for this), scored on recall accuracy, honesty on empty dates, and correctness of the "changed" verdicts.
- **A claim ledger**: store each volatile fact as a row with its source, so re-checks diff claim by claim and can run as a scheduled watch that speaks up only when something changed.
- **Recall at larger scale**: embeddings as a third layer once history outgrows the timeline.
- **Latency tuning**: measure effort levels per question type and drop to low effort for turns that need no search.
