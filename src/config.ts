/** Settings, read once from the environment (and from .env if present). */

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on the real environment.
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  /**
   * The model that talks to the user. It must be one of Groq's models with
   * the built-in browser search tool (the GPT-OSS family), which runs the
   * searches on Groq's side inside one request.
   */
  model: process.env.AGENT_MODEL || "openai/gpt-oss-120b",
  /**
   * How hard the model reasons before answering: low | medium | high.
   * Low is the default because Groq's free tier allows few tokens per minute.
   */
  effort: (["low", "medium", "high"] as const).find((e) => e === process.env.AGENT_EFFORT) ?? "low",
  /**
   * The most tokens one request may use, prompt and reply together. Groq
   * rejects a request that asks for more than the account's per-minute
   * allowance, which is 8,000 on the free tier. The prompt is sized to fit.
   * Raise this on a paid tier to give the agent more history and longer replies.
   */
  tokenBudget: Math.max(4000, Number(process.env.TOKEN_BUDGET) || 8000),
  /** A small, fast model that summarises each finished turn for memory. */
  digestModel: process.env.DIGEST_MODEL || "openai/gpt-oss-20b",
  dbPath: process.env.DB_PATH || "data/memory.db",
  hasApiKey: Boolean(process.env.GROQ_API_KEY),
  /** Set DEBUG_STREAM=1 to print each search step the API reports, for troubleshooting. */
  debugStream: Boolean(process.env.DEBUG_STREAM),
};

export type Config = typeof config;
