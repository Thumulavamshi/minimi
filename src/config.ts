/** Settings, read once from the environment (and from .env if present). */

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on the real environment.
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

function effort(value: string | undefined, fallback: Effort): Effort {
  return EFFORTS.includes(value as Effort) ? (value as Effort) : fallback;
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  /** The model that talks to the user and searches the web. */
  model: process.env.AGENT_MODEL || "claude-opus-5-5",
  /** How hard the model thinks. Lower is faster; higher checks more. */
  effort: effort(process.env.AGENT_EFFORT, "medium"),
  /** A small, fast model that summarises each finished turn for memory. */
  digestModel: process.env.DIGEST_MODEL || "claude-haiku-5-5",
  /** The most web searches one answer may run. */
  maxSearches: Number(process.env.MAX_SEARCHES) || 8,
  /**
   * If the model's safety filter declines a request, let the API retry it on
   * the fallback model it recommends, so a false positive does not become a
   * dead end. Set REFUSAL_FALLBACK=off to disable.
   */
  refusalFallback: process.env.REFUSAL_FALLBACK !== "off",
  dbPath: process.env.DB_PATH || "data/memory.db",
  hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
};

export type Config = typeof config;
