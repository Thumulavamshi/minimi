# Chat agent with web search and a dated memory

A chat agent with one tool, web search. It keeps a dated record of what you asked and what it answered, so it can tell you what it said on 3 November and check whether that is still true today.

The reasoning behind it is in [DESIGN.md](DESIGN.md).

## Run it

Needs Node.js 22.13 or newer.

```bash
npm install
```

```bash
cp .env.example .env
```

Put your Groq API key in `.env` as `GROQ_API_KEY` (it is the only key needed; create one at https://console.groq.com/keys), then:

```bash
npm run dev
```

Open http://localhost:3000.

## Try the memory without waiting a week

The agent starts with an empty memory, and says so if you ask about a day it has no record of. To try questions about the past straight away, load three dated demo conversations:

```bash
npm run seed
```

Then ask:

- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"

The demo prices are illustrative snapshots, there to be re-checked. `npm run seed -- --clear` removes them, and `npm run seed -- your-file.json` loads your own history in the same format as `data/demo-history.json`.

To move the clock instead, set `AGENT_NOW` in `.env` (for example `2026-11-12T10:00:00+05:30`) and restart.

Under each answer, "How this was answered" shows the dates the app read from your message, the earlier turns it recalled, the searches it ran, and the exact context the model was given.

Each source under an answer carries a mark from the app's link check: ✓ returned by this answer's search, ↺ carried over from an earlier answer, ~ a different page on a searched site, ? not in the search results (the model supplied it).

## Evaluation

```bash
npm run eval
```

Runs 46 scenarios through date reading and memory lookup. No model or network is involved, so the result is exact. Current result, from `eval/recall-results.md`:

| Category | Passed |
|---|---|
| Exact date | 8 / 8 |
| Relative date | 8 / 8 |
| Ambiguous date | 5 / 5 |
| Topic recall | 6 / 8 |
| Missing history | 6 / 6 |
| No recall needed | 7 / 7 |
| Timezone | 4 / 4 |
| **Total** | **44 / 46** |

The two misses are paraphrases that share no word with the stored conversation ("notebook computer" for "laptop"). Keyword lookup cannot find those; the model can, from the timeline of earlier conversations it is always given.

```bash
npm run eval:live
```

Asks nine questions of the live model and the live web (needs `GROQ_API_KEY`, takes about five minutes because it paces itself for the free tier) and checks each answer with rules: the right day recalled, a missing day admitted, no search for small talk, and every cited link among the search results. It writes `eval/live-results.md`. Add `-- --no-memory` to ask the same questions with an empty memory for comparison.

## Tests

```bash
npm test
```

The tests need no API key. They cover date resolution, recall (including the three questions above), and the agent loop against a scripted model.

## Layout

| Path | What it does |
|---|---|
| `src/time/` | Timezone-aware calendar maths; turns "last Tuesday" into exact dates |
| `src/memory/store.ts` | SQLite store of dated turns with a keyword index |
| `src/memory/recall.ts` | Finds the past turns a message refers to, before the model runs |
| `src/memory/timeline.ts` | One-line history of earlier conversations for the system prompt |
| `src/memory/digest.ts` | Background summary of each finished turn, with its claims and their sources |
| `src/agent/prompt.ts` | The system prompt and how stored turns are replayed |
| `src/agent/turn.ts` | One turn: recall, assemble, answer, remember |
| `src/agent/stream.ts` | Model stream to UI events; reads the source list out of the answer and checks each link |
| `src/server.ts` | HTTP API, streaming chat endpoint, static files |
| `public/` | The chat page (no build step) |
| `eval/` | Recall scenarios, the live evaluation, and their results |
