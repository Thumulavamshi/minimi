/**
 * Translates the model's raw stream into the few events the chat UI needs,
 * and collects what will be stored: the answer text, its sources, the queries.
 *
 * Kept free of network and storage code so it can be tested with hand-written
 * events.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Source } from "../memory/store.ts";

type StreamEvent = Anthropic.Beta.Messages.BetaRawMessageStreamEvent;

export type AgentEvent =
  /** A step the user can watch while waiting. */
  | { type: "activity"; kind: "thinking" | "searching" | "reading" | "search_failed"; detail?: string }
  | { type: "text"; text: string }
  | { type: "source"; source: Source };

interface OpenBlock {
  kind: "text" | "tool" | "other";
  /** For a tool call: its name and its input JSON as it streams in. */
  toolName?: string;
  inputJson?: string;
  /** For a text block: the pages the API says this text was drawn from. */
  citedUrls?: Array<{ url: string; title: string }>;
}

/** Brackets and spaces would break a Markdown link, so they are escaped. */
function linkSafe(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
}

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
  private blocks = new Map<number, OpenBlock>();
  private readonly emit: (event: AgentEvent) => void;

  constructor(emit: (event: AgentEvent) => void) {
    this.emit = emit;
  }

  handle(event: StreamEvent): void {
    switch (event.type) {
      case "message_start":
        // A turn that pauses and resumes arrives as several messages, each
        // numbering its blocks from zero.
        this.blocks = new Map();
        break;
      case "content_block_start":
        this.blocks.set(event.index, this.open(event.content_block));
        break;
      case "content_block_delta": {
        const block = this.blocks.get(event.index);
        const delta = event.delta;
        if (delta.type === "text_delta") {
          this.write(delta.text);
        } else if (delta.type === "input_json_delta" && block) {
          block.inputJson = (block.inputJson ?? "") + delta.partial_json;
        } else if (delta.type === "citations_delta" && block && delta.citation.type === "web_search_result_location") {
          (block.citedUrls ??= []).push({ url: delta.citation.url, title: delta.citation.title ?? hostname(delta.citation.url) });
        }
        break;
      }
      case "content_block_stop": {
        const block = this.blocks.get(event.index);
        if (block) this.close(block);
        break;
      }
    }
  }

  private open(block: Extract<StreamEvent, { type: "content_block_start" }>["content_block"]): OpenBlock {
    switch (block.type) {
      case "thinking":
        this.emit({ type: "activity", kind: "thinking" });
        return { kind: "other" };
      case "text":
        return { kind: "text" };
      case "server_tool_use":
        // The query is not known until the tool input has finished streaming.
        this.emit({ type: "activity", kind: "searching" });
        return { kind: "tool", toolName: block.name, inputJson: "" };
      case "web_search_tool_result":
        // A list means results; a single object means the search failed.
        if (Array.isArray(block.content)) {
          const sites = [...new Set(block.content.map((result) => hostname(result.url)))];
          const shown = sites.slice(0, 4).join(", ");
          this.emit({ type: "activity", kind: "reading", detail: sites.length > 4 ? `${shown} and ${sites.length - 4} more` : shown });
        } else {
          this.emit({ type: "activity", kind: "search_failed", detail: block.content.error_code });
        }
        return { kind: "other" };
      default:
        return { kind: "other" };
    }
  }

  private close(block: OpenBlock): void {
    if (block.kind === "tool" && block.toolName === "web_search") {
      const query = this.queryFrom(block.inputJson);
      if (query) {
        this.searches.push(query);
        this.emit({ type: "activity", kind: "searching", detail: query });
      }
    }
    if (block.kind === "text" && block.citedUrls?.length) {
      // Append one numbered link per page this passage was drawn from. Writing
      // them into the text means the stored answer carries its own evidence.
      const numbers = [...new Set(block.citedUrls.map((cited) => this.sourceNumber(cited.url, cited.title)))];
      const byNumber = new Map(this.sources.map((s) => [s.n, s]));
      this.write(numbers.map((n) => ` [${n}](${linkSafe(byNumber.get(n)!.url)})`).join(""));
    }
  }

  private queryFrom(inputJson: string | undefined): string | null {
    try {
      const input = JSON.parse(inputJson || "{}") as { query?: unknown };
      return typeof input.query === "string" && input.query.trim() ? input.query.trim() : null;
    } catch {
      return null;
    }
  }

  /** Each page gets one number for the whole answer, in order of first use. */
  private sourceNumber(url: string, title: string): number {
    const known = this.sources.find((s) => s.url === url);
    if (known) return known.n;
    const source: Source = { n: this.sources.length + 1, url, title };
    this.sources.push(source);
    this.emit({ type: "source", source });
    return source.n;
  }

  /** Adds text to the answer and sends it on. */
  write(text: string): void {
    if (!text) return;
    this.answer += text;
    this.emit({ type: "text", text });
  }
}
