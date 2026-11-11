/**
 * The durable record of every conversation.
 *
 * The unit of memory is a turn: one question, the answer given, when, and the
 * sources the answer rested on. Keeping the timestamp and the sources beside
 * the answer is what lets the agent later say "on 3 November I told you X,
 * citing Y" and then check whether X still holds.
 *
 * SQLite ships with Node (node:sqlite), so there is no native module to build
 * and nothing to run beside the app.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Where a cited link came from, checked by the app after the answer:
 *   search    a page this answer's web searches returned
 *   memory    a page cited in an earlier answer the model was shown
 *   site      a different page on a site the searches returned
 *   unlisted  none of the above: the model supplied the address itself
 */
export type SourceOrigin = "search" | "memory" | "site" | "unlisted";

export interface Source {
  /** The citation number used in the answer text. */
  n: number;
  url: string;
  title: string;
  /** Absent when the check could not be made (the API reported no result pages). */
  origin?: SourceOrigin;
  /** What the search returned for this page, kept as evidence of what was seen. */
  excerpt?: string;
}

/** One fact from an answer that could change, with the page it was drawn from. */
export interface Claim {
  text: string;
  source: string | null;
}

/** A compact summary of a turn, written by a small model after the answer. */
export interface Digest {
  title: string;
  summary: string;
  /** Products, companies, people: the names a later question would use. */
  entities: string[];
  /** Specific facts stated in the answer that could change over time. */
  claims: Claim[];
  /** True when the answer depends on facts that go stale (prices, versions, news). */
  volatile: boolean;
  /** A question that would re-verify this answer later, or null. */
  recheck: string | null;
}

export type TurnStatus = "complete" | "interrupted" | "error";

export interface TurnStats {
  model?: string;
  totalMs?: number;
  firstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** Set for demo history inserted by `npm run seed`. */
  seeded?: boolean;
}

export interface Turn {
  id: string;
  conversationId: string;
  createdAt: number;
  question: string;
  /**
   * The context block the app placed in front of the question (the current
   * time, resolved dates, recalled memory). Stored so the conversation can be
   * replayed to the model byte-for-byte, which keeps the prompt cache valid
   * and leaves an audit trail of what the model was shown.
   */
  contextNote: string;
  answer: string;
  sources: Source[];
  searches: string[];
  status: TurnStatus;
  digest: Digest | null;
  stats: TurnStats;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface TurnRow {
  id: string;
  conversation_id: string;
  created_at: number;
  question: string;
  context_note: string;
  answer: string;
  sources: string;
  searches: string;
  status: string;
  digest: string | null;
  stats: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    question TEXT NOT NULL,
    context_note TEXT NOT NULL,
    answer TEXT NOT NULL,
    sources TEXT NOT NULL,
    searches TEXT NOT NULL,
    status TEXT NOT NULL,
    digest TEXT,
    stats TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS turns_by_time ON turns(created_at);
  CREATE INDEX IF NOT EXISTS turns_by_conversation ON turns(conversation_id, created_at);
  -- Keyword index over each turn. Porter stemming lets "pricing" find "prices".
  CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
    turn_id UNINDEXED, body, tokenize = 'porter unicode61'
  );
`;

/** Digests written before claims carried a source stored them as plain strings. */
function toDigest(json: string): Digest {
  const digest = JSON.parse(json) as Omit<Digest, "claims"> & { claims: Array<string | Claim> };
  return { ...digest, claims: digest.claims.map((c) => (typeof c === "string" ? { text: c, source: null } : c)) };
}

function toTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    question: row.question,
    contextNote: row.context_note,
    answer: row.answer,
    sources: JSON.parse(row.sources) as Source[],
    searches: JSON.parse(row.searches) as string[],
    status: row.status as TurnStatus,
    digest: row.digest ? toDigest(row.digest) : null,
    stats: JSON.parse(row.stats) as TurnStats,
  };
}

/** The text a keyword search should match for a turn. */
function searchableText(turn: Turn): string {
  const d = turn.digest;
  return [turn.question, d?.title, d?.summary, d?.entities.join(" "), d?.claims.map((c) => c.text).join(" "), turn.answer]
    .filter(Boolean)
    .join("\n");
}

export class MemoryStore {
  private readonly db: DatabaseSync;

  /** Pass ":memory:" for a throwaway store in tests. */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  createConversation(conversation: Conversation): void {
    this.db
      .prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt);
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
      | { id: string; title: string; created_at: number; updated_at: number }
      | undefined;
    return row ? { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  listConversations(): Conversation[] {
    const rows = this.db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all() as Array<{
      id: string;
      title: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  renameConversation(id: string, title: string): void {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
  }

  deleteConversation(id: string): void {
    this.db
      .prepare("DELETE FROM turns_fts WHERE turn_id IN (SELECT id FROM turns WHERE conversation_id = ?)")
      .run(id);
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  }

  saveTurn(turn: Turn): void {
    this.db
      .prepare(
        `INSERT INTO turns (id, conversation_id, created_at, question, context_note, answer, sources, searches, status, digest, stats)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.id,
        turn.conversationId,
        turn.createdAt,
        turn.question,
        turn.contextNote,
        turn.answer,
        JSON.stringify(turn.sources),
        JSON.stringify(turn.searches),
        turn.status,
        turn.digest ? JSON.stringify(turn.digest) : null,
        JSON.stringify(turn.stats),
      );
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(turn.createdAt, turn.conversationId);
    this.index(turn);
  }

  setDigest(turnId: string, digest: Digest): void {
    this.db.prepare("UPDATE turns SET digest = ? WHERE id = ?").run(JSON.stringify(digest), turnId);
    const turn = this.getTurn(turnId);
    if (turn) this.index(turn);
  }

  private index(turn: Turn): void {
    this.db.prepare("DELETE FROM turns_fts WHERE turn_id = ?").run(turn.id);
    this.db.prepare("INSERT INTO turns_fts (turn_id, body) VALUES (?, ?)").run(turn.id, searchableText(turn));
  }

  getTurn(id: string): Turn | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as TurnRow | undefined;
    return row ? toTurn(row) : null;
  }

  turnsInConversation(conversationId: string): Turn[] {
    const rows = this.db
      .prepare("SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at")
      .all(conversationId) as unknown as TurnRow[];
    return rows.map(toTurn);
  }

  countTurns(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM turns").get() as { n: number }).n;
  }

  /** Turns asked in [startMs, endMs), oldest first. */
  turnsBetween(startMs: number, endMs: number, limit = 50): Turn[] {
    const rows = this.db
      .prepare("SELECT * FROM turns WHERE created_at >= ? AND created_at < ? ORDER BY created_at LIMIT ?")
      .all(startMs, endMs, limit) as unknown as TurnRow[];
    return rows.map(toTurn);
  }

  /** The closest turn before one instant and the closest at or after another. */
  nearest(beforeMs: number, afterMs: number): { before: Turn | null; after: Turn | null } {
    const before = this.db
      .prepare("SELECT * FROM turns WHERE created_at < ? ORDER BY created_at DESC LIMIT 1")
      .get(beforeMs) as TurnRow | undefined;
    const after = this.db
      .prepare("SELECT * FROM turns WHERE created_at >= ? ORDER BY created_at LIMIT 1")
      .get(afterMs) as TurnRow | undefined;
    return { before: before ? toTurn(before) : null, after: after ? toTurn(after) : null };
  }

  /** Turns matching any of the keywords, best match first. */
  search(keywords: string[], limit: number): Turn[] {
    const terms = keywords.map((k) => k.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
    if (terms.length === 0) return [];
    const query = terms.map((t) => `"${t}"`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT turns.* FROM turns_fts JOIN turns ON turns.id = turns_fts.turn_id
         WHERE turns_fts MATCH ? ORDER BY bm25(turns_fts) LIMIT ?`,
      )
      .all(query, limit) as unknown as TurnRow[];
    return rows.map(toTurn);
  }

  /** The most recent turns from other conversations, oldest first. */
  turnsBefore(ms: number, excludeConversationId: string, limit: number): Turn[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM turns WHERE created_at < ? AND conversation_id != ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(ms, excludeConversationId, limit) as unknown as TurnRow[];
    return rows.map(toTurn).reverse();
  }

  /** Recent turns whose answers rest on facts that go stale, newest first. */
  volatileTurns(limit: number): Turn[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM turns WHERE status = 'complete' AND json_extract(digest, '$.volatile') = 1
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as TurnRow[];
    return rows.map(toTurn);
  }

  close(): void {
    this.db.close();
  }
}
