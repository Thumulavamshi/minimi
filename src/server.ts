/**
 * The web server: a small JSON API, a streaming chat endpoint, and the static
 * chat page. Built on node:http directly; there are six routes.
 */
import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { runTurn, type TurnEvent } from "./agent/turn.ts";
import { config } from "./config.ts";
import { MemoryStore } from "./memory/store.ts";
import { formatDay, isValidTimeZone, nowMs, zonedParts } from "./time/zoned.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");

/** Browser libraries served straight from node_modules, so there is no build step. */
const VENDOR: Record<string, string> = {
  "/vendor/marked.js": "node_modules/marked/lib/marked.umd.js",
  "/vendor/purify.js": "node_modules/dompurify/dist/purify.min.js",
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const store = new MemoryStore(join(ROOT, config.dbPath));

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new Error("Request body is too large.");
  }
  const parsed: unknown = JSON.parse(raw || "{}");
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function serveFile(res: ServerResponse, path: string): void {
  if (!existsSync(path)) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(res);
}

/**
 * Answers worth a second look: earlier answers that rested on facts which go
 * stale, and are now at least two days old. They are offered as one-click
 * prompts on the start screen. Nothing is searched until the user clicks.
 */
function followUps(timezone: string): Array<{ label: string; prompt: string }> {
  const now = nowMs();
  const seen = new Set<string>();
  const out: Array<{ label: string; prompt: string }> = [];
  for (const turn of store.volatileTurns(30)) {
    const digest = turn.digest;
    if (!digest?.recheck || now - turn.createdAt < 2 * 86_400_000) continue;
    const key = digest.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const days = Math.round((now - turn.createdAt) / 86_400_000);
    out.push({ label: `${digest.title} · ${days} days ago`, prompt: `On ${formatDay(zonedParts(turn.createdAt, timezone))} I asked you: "${turn.question}" Is your answer still correct today?` });
    if (out.length === 3) break;
  }
  return out;
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    sendJson(res, 400, { error: "The message is empty." });
    return;
  }

  // Server-sent events: one line of JSON per event, flushed as it happens.
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const emit = (event: TurnEvent): void => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // If the browser goes away (or the user presses Stop), stop paying for the answer.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  try {
    await runTurn(
      { store, config },
      {
        message,
        conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
        timezone: isValidTimeZone(body.timezone) ? body.timezone : "UTC",
        signal: abort.signal,
        emit,
      },
    );
  } catch (error) {
    console.error("[chat]", error);
    emit({ type: "error", message: "Something went wrong on the server. See its log for details." });
  }
  res.end();
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "POST" && path === "/api/chat") return handleChat(req, res);

  if (req.method === "GET" && path === "/api/state") {
    const timezone = url.searchParams.get("tz");
    return sendJson(res, 200, {
      conversations: store.listConversations(),
      followUps: followUps(isValidTimeZone(timezone) ? timezone : "UTC"),
      model: config.model,
      hasApiKey: config.hasApiKey,
    });
  }

  const conversation = /^\/api\/conversations\/([\w-]+)$/.exec(path);
  if (conversation) {
    const id = conversation[1]!;
    if (req.method === "GET") {
      const found = store.getConversation(id);
      return found ? sendJson(res, 200, { conversation: found, turns: store.turnsInConversation(id) }) : sendJson(res, 404, { error: "Not found" });
    }
    if (req.method === "DELETE") {
      store.deleteConversation(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (req.method === "GET") {
    if (VENDOR[path]) return serveFile(res, join(ROOT, VENDOR[path]));
    // normalize() collapses "..", and the prefix check keeps requests inside public/.
    const file = normalize(join(PUBLIC_DIR, path === "/" ? "index.html" : path));
    if (file.startsWith(PUBLIC_DIR)) return serveFile(res, file);
  }
  sendJson(res, 404, { error: "Not found" });
}

const server = createServer((req, res) => {
  route(req, res).catch((error: unknown) => {
    console.error("[server]", error);
    if (!res.headersSent) sendJson(res, 500, { error: "Server error" });
    else res.end();
  });
});

server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE" ? `Port ${config.port} is in use. Set PORT in .env to another port.` : error);
  process.exit(1);
});

// Bound to this machine only: the app holds one person's private history.
server.listen(config.port, "127.0.0.1", () => {
  console.log(`\n  Chat agent ready at http://localhost:${config.port}`);
  console.log(`  Model: ${config.model} · Memory: ${config.dbPath} (${store.countTurns()} turns)`);
  if (!config.hasApiKey) console.log("  No GROQ_API_KEY found. Copy .env.example to .env and add your key.");
  console.log();
});
