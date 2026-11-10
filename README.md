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

Put your Anthropic API key in `.env` (it is the only key needed), then:

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
| `src/memory/digest.ts` | Background summary of each finished turn |
| `src/agent/prompt.ts` | The system prompt and how stored turns are replayed |
| `src/agent/turn.ts` | One turn: recall, assemble, answer, remember |
| `src/agent/stream.ts` | Model stream to UI events, with numbered citations |
| `src/server.ts` | HTTP API, streaming chat endpoint, static files |
| `public/` | The chat page (no build step) |
