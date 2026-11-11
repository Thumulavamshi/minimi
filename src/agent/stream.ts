/**
 * Translates the model's raw stream into the few events the chat UI needs,
 * and collects what will be stored: the answer text, its sources, the queries.
 *
 * Kept free of network and storage code so it can be tested with hand-written
 * chunks.
 */
import type Groq from "groq-sdk";
import type { Source } from "../memory/store.ts";

type Chunk = Groq.Chat.Completions.ChatCompletionChunk;
type ExecutedTool = NonNullable<Chunk["choices"][number]["delta"]["executed_tools"]>[number];

export type AgentEvent =
  /** A step the user can watch while waiting. */
  | { type: "activity"; kind: "thinking" | "searching" | "reading"; detail?: string }
  | { type: "text"; text: string }
  | { type: "source"; source: Source };

/** A numbered or named Markdown link: [1](https://…) or [Neon](https://…). */
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * GPT-OSS models mark what they read with their own bracket notation, such as
 * 【3†L10-L14】. It refers to pages inside the model's browsing session and
 * means nothing to a reader, so it is removed from the answer.
 */
const BROWSER_MARK = /\s?【[^】]*】/g;
/** The longest run of text held back while waiting for a mark to close. */
const MAX_HELD = 80;
/** How many pages to list as sources when the answer contains no links. */
const FALLBACK_SOURCES = 6;

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export class StreamTranslator {
  answer = "";
  readonly sources: Source[] = [];
  readonly searches: string[] = [];
  /** Pages the searches returned, in order: URL to title. */
  private readonly pages = new Map<string, string>();
  /** Searches are reported in pieces; these record what has been shown already. */
  private readonly announced = new Set<number>();
  private readonly read = new Set<number>();
  private thinking = false;
  /** Answer text not yet sent on, because it may be the start of a bracket mark. */
  private held = "";
  private readonly emit: (event: AgentEvent) => void;

  constructor(emit: (event: AgentEvent) => void) {
    this.emit = emit;
  }

  handle(chunk: Chunk): void {
    const delta = chunk.choices[0]?.delta;
    if (!delta) return;
    if (delta.reasoning && !this.thinking) {
      this.thinking = true;
      this.emit({ type: "activity", kind: "thinking" });
    }
    for (const tool of delta.executed_tools ?? []) this.tool(tool);
    if (delta.content) this.modelText(delta.content);
  }

  /** A search arrives first as a call, then again with its results. */
  private tool(tool: ExecutedTool): void {
    if (!this.announced.has(tool.index)) {
      this.announced.add(tool.index);
      const query = this.queryFrom(tool.arguments);
      if (query) this.searches.push(query);
      this.emit({ type: "activity", kind: "searching", detail: query ?? undefined });
    }
    // Results come as search hits or as opened pages, depending on the step.
    const results = [...(tool.search_results?.results ?? []), ...(tool.browser_results ?? [])];
    if (results.length > 0 && !this.read.has(tool.index)) {
      this.read.add(tool.index);
      for (const result of results) {
        if (result.url && !this.pages.has(result.url)) this.pages.set(result.url, result.title || hostname(result.url));
      }
      const sites = [...new Set(results.flatMap((result) => (result.url ? [hostname(result.url)] : [])))];
      if (sites.length === 0) return;
      const shown = sites.slice(0, 4).join(", ");
      this.emit({ type: "activity", kind: "reading", detail: sites.length > 4 ? `${shown} and ${sites.length - 4} more` : shown });
    }
  }

  /** The search query, whether the arguments are JSON or a call written as text. */
  private queryFrom(args: string | undefined): string | null {
    if (!args) return null;
    try {
      const parsed = JSON.parse(args) as { query?: unknown };
      if (typeof parsed.query === "string" && parsed.query.trim()) return parsed.query.trim();
      return null;
    } catch {
      return /query["']?\s*[:=]\s*["']([^"']+)["']/.exec(args)?.[1]?.trim() ?? null;
    }
  }

  /** Text from the model: strip bracket marks, even when one is split across chunks. */
  private modelText(text: string): void {
    const pending = (this.held + text).replace(BROWSER_MARK, "");
    const open = pending.lastIndexOf("【");
    if (open >= 0 && pending.length - open <= MAX_HELD) {
      this.held = pending.slice(open);
      this.write(pending.slice(0, open));
    } else {
      this.held = "";
      this.write(pending);
    }
  }

  /** Adds text to the answer and sends it on. */
  write(text: string): void {
    if (!text) return;
    this.answer += text;
    this.emit({ type: "text", text });
  }

  /**
   * Called when the stream ends. The model is asked to cite pages as Markdown
   * links, so the list of sources is read back out of the answer: each
   * distinct page once, in the order it was first cited. If the answer has no
   * links, the pages the searches returned are listed instead, so the reader
   * can still see where the answer came from.
   */
  finish(): void {
    this.write(this.held.replace(BROWSER_MARK, ""));
    this.held = "";
    for (const match of this.answer.matchAll(LINK)) {
      const [, label, url] = match as unknown as [string, string, string];
      if (this.sources.some((s) => s.url === url)) continue;
      this.addSource(url, this.pages.get(url) ?? (/^\d+$/.test(label) ? hostname(url) : label));
    }
    if (this.sources.length === 0) {
      for (const [url, title] of [...this.pages].slice(0, FALLBACK_SOURCES)) this.addSource(url, title);
    }
  }

  private addSource(url: string, title: string): void {
    const source: Source = { n: this.sources.length + 1, url, title };
    this.sources.push(source);
    this.emit({ type: "source", source });
  }
}
