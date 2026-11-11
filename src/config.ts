/** Settings, read once from the environment (and from .env if present). */

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on the real environment.
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  /**
   * The model that talks to the user. "groq/compound" is Groq's system with
   * web search built in: it runs the searches on Groq's side inside one request.
   */
  model: process.env.AGENT_MODEL || "groq/compound",
  /** A small, fast model that summarises each finished turn for memory. */
  digestModel: process.env.DIGEST_MODEL || "openai/gpt-oss-20b",
  dbPath: process.env.DB_PATH || "data/memory.db",
  hasApiKey: Boolean(process.env.GROQ_API_KEY),
};

export type Config = typeof config;
