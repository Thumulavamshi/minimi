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
  /** Page titles seen in search results, used to label the sources. */
  private readonly titles = new Map<string, string>();
  /** Searches are reported in pieces; these record what has been shown already. */
  private readonly announced = new Set<number>();
  private readonly read = new Set<number>();
  private thinking = false;
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
    if (delta.content) this.write(delta.content);
  }

  /** A search arrives first as a query, then again with its results. */
  private tool(tool: ExecutedTool): void {
    if (!this.announced.has(tool.index)) {
      this.announced.add(tool.index);
      const query = this.queryFrom(tool.arguments);
      if (query) this.searches.push(query);
      this.emit({ type: "activity", kind: "searching", detail: query ?? undefined });
    }
    const results = tool.search_results?.results ?? [];
    if (results.length > 0 && !this.read.has(tool.index)) {
      this.read.add(tool.index);
      for (const result of results) {
        if (result.url && result.title) this.titles.set(result.url, result.title);
      }
      const sites = [...new Set(results.flatMap((result) => (result.url ? [hostname(result.url)] : [])))];
      const shown = sites.slice(0, 4).join(", ");
      this.emit({ type: "activity", kind: "reading", detail: sites.length > 4 ? `${shown} and ${sites.length - 4} more` : shown });
    }
  }

  private queryFrom(args: string): string | null {
    try {
      const parsed = JSON.parse(args || "{}") as { query?: unknown };
      if (typeof parsed.query === "string" && parsed.query.trim()) return parsed.query.trim();
    } catch {
      // Not JSON: fall through and use the raw text.
    }
    return args?.trim() ? args.trim().slice(0, 200) : null;
  }

  /** Adds text to the answer and sends it on. */
  write(text: string): void {
    if (!text) return;
    this.answer += text;
    this.emit({ type: "text", text });
  }

  /**
   * Called when the stream ends. The model writes its citations into the answer
   * as Markdown links, so the list of sources is read back out of the text:
   * each distinct page once, in the order it was first cited.
   */
  finish(): void {
    for (const match of this.answer.matchAll(LINK)) {
      const [, label, url] = match as unknown as [string, string, string];
      if (this.sources.some((s) => s.url === url)) continue;
      const title = this.titles.get(url) ?? (/^\d+$/.test(label) ? hostname(url) : label);
      const source: Source = { n: this.sources.length + 1, url, title };
      this.sources.push(source);
      this.emit({ type: "source", source });
    }
  }
}
