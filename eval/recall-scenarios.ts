/**
 * Scenarios for the part of the agent that runs without a model: reading
 * dates out of a message and finding the conversations it refers to.
 *
 * Each scenario fixes the clock, the timezone and the stored history, sends
 * one message through recall, and states which past turns must come back.
 * Because nothing here calls a model, results are exact and repeatable.
 */
import type { Turn } from "../src/memory/store.ts";

export interface Scenario {
  category: string;
  name: string;
  message: string;
  /** Defaults to Thursday 12 November 2026, 14:30 in Bengaluru. */
  now?: string;
  timezone?: string;
  history?: Turn[];
  /** Ids of the turns that must be recalled: exactly these, in any order. Omit to skip this check. */
  recalled?: string[];
  /** Patterns the context given to the model must, and must not, contain. */
  context?: RegExp[];
  notContext?: RegExp[];
}

export const NOW = "2026-11-12T09:00:00Z";
export const TIMEZONE = "Asia/Kolkata";

function turn(id: string, at: string, question: string, answer: string, digest?: { title: string; entities: string[] }): Turn {
  return {
    id,
    conversationId: `c-${id}`,
    createdAt: Date.parse(at),
    question,
    contextNote: "",
    answer,
    sources: [],
    searches: [],
    status: "complete",
    digest: digest ? { ...digest, summary: answer, claims: [], volatile: true, recheck: null } : null,
    stats: {},
  };
}

/** Eight conversations over a month. Times in comments are Bengaluru time. */
export const HISTORY: Turn[] = [
  turn("flight", "2026-10-14T03:30:00Z", "How much are flights from Bengaluru to Delhi in December?", "Roughly 5,500 to 9,000 rupees one way."), // Wed 14 Oct 09:00
  turn("laptop", "2026-10-24T06:30:00Z", "Which laptop should I buy for programming under 80,000 rupees?", "A ThinkPad E14, or a refurbished MacBook Air."), // Sat 24 Oct 12:00
  turn("node", "2026-11-03T04:35:00Z", "What is the current LTS version of Node.js? I'm setting up a new service.", "Node.js 24 is the Active LTS line.", {
    title: "Node.js LTS version",
    entities: ["Node.js"],
  }), // Tue 3 Nov 10:05
  turn("dal", "2026-11-05T13:00:00Z", "How do I make dal tadka?", "Boil the lentils, then temper cumin and garlic in ghee.", {
    title: "Dal tadka recipe",
    entities: [],
  }), // Thu 5 Nov 18:30
  turn("ts", "2026-11-06T09:30:00Z", "What does the satisfies operator do in TypeScript?", "It checks a value against a type without widening it."), // Fri 6 Nov 15:00
  turn("crm", "2026-11-09T05:00:00Z", "Help me shortlist 5 CRM tools for a 20-person sales team.", "HubSpot, Pipedrive, Salesforce, Zoho CRM and Close.", {
    title: "CRM shortlist for sales team",
    entities: ["HubSpot", "Pipedrive", "Salesforce", "Zoho CRM", "Close"],
  }), // Mon 9 Nov 10:30
  turn("pg", "2026-11-10T05:50:00Z", "I need managed Postgres hosting for a small SaaS. What are the options and what do they cost?", "Neon Launch is about $19/month and Supabase Pro is $25/month.", {
    title: "Postgres hosting options",
    entities: ["Neon", "Supabase", "Render", "AWS RDS"],
  }), // Tue 10 Nov 11:20
  turn("today", "2026-11-12T03:30:00Z", "Will it rain in Bengaluru this afternoon?", "Light showers are likely after 4 pm."), // Thu 12 Nov 09:00
];

/** One conversation at 15:30 on 9 Nov in Bengaluru, which is 02:00 on 9 Nov in Los Angeles. */
const TZ_HISTORY = [turn("office", "2026-11-09T10:00:00Z", "Is the Mumbai office open on Diwali?", "It is closed on the main day.")];
/** 02:00 on 10 Nov in Bengaluru; 12:30 on 9 Nov in Los Angeles. */
const TZ_NOW = "2026-11-09T20:30:00Z";

const QUOTED = /<past_turn/;
const NOTHING = /nothing was recorded/;
const LOOKUP = /Memory lookup/;

export const SCENARIOS: Scenario[] = [
  // A date written out: the right day's conversation, and only that.
  { category: "Exact date", name: "day and month", message: "What did I ask you on 3 November?", recalled: ["node"], context: [QUOTED] },
  { category: "Exact date", name: "short month", message: "What did we talk about on 9 Nov?", recalled: ["crm"] },
  { category: "Exact date", name: "month first, ordinal", message: "What did I ask on November 5th?", recalled: ["dal"] },
  { category: "Exact date", name: "ISO date", message: "Show me what I asked on 2026-10-24", recalled: ["laptop"] },
  { category: "Exact date", name: "'the 14th of October'", message: "What was my question on the 14th of October?", recalled: ["flight"], context: [QUOTED] },
  { category: "Exact date", name: "slash date, day first", message: "What did I ask you on 06/11/2026?", recalled: ["ts"] },
  { category: "Exact date", name: "date with year", message: "What did we discuss on 6 November 2026?", recalled: ["ts"] },
  { category: "Exact date", name: "abbreviated, month first", message: "What did I ask you on Oct 24?", recalled: ["laptop"] },

  // A date relative to now.
  { category: "Relative date", name: "weekday this week (brief's CRM prompt)", message: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing?", recalled: ["crm"] },
  { category: "Relative date", name: "last Friday", message: "What did I ask you last Friday?", recalled: ["ts"] },
  { category: "Relative date", name: "N days ago", message: "What did I ask you 3 days ago?", recalled: ["crm"] },
  { category: "Relative date", name: "day before yesterday", message: "What did I ask you the day before yesterday?", recalled: ["pg"] },
  { category: "Relative date", name: "last week", message: "What did we discuss last week?", recalled: ["node", "dal", "ts"] },
  { category: "Relative date", name: "about a week ago", message: "What did I ask you about a week ago?", recalled: ["node", "dal", "ts"] },
  { category: "Relative date", name: "last month", message: "What did I ask you last month?", recalled: ["flight", "laptop"] },
  { category: "Relative date", name: "earlier today", message: "What did I ask you earlier today?", recalled: ["today"] },

  // "Last Tuesday", said on a Thursday, has two readings and both have records.
  { category: "Ambiguous date", name: "topic settles it (brief's Postgres prompt)", message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", recalled: ["pg"], context: [/chosen by topic/, QUOTED], notContext: [/ask which day/] },
  { category: "Ambiguous date", name: "topic settles it the other way", message: "Last Tuesday I asked about Node versions. Is that still right?", recalled: ["node"], context: [/chosen by topic/] },
  { category: "Ambiguous date", name: "no topic: show both and ask", message: "What did I ask you last Tuesday?", recalled: ["pg", "node"], context: [/ask which day/], notContext: [QUOTED] },
  { category: "Ambiguous date", name: "two readings, one with records", message: "What did I ask you last Monday?", recalled: ["crm"], notContext: [/more than one date/] },
  { category: "Ambiguous date", name: "two readings, neither with records", message: "What did I ask you last Wednesday?", recalled: [], context: [NOTHING] },

  // No date: found by what the conversation was about.
  { category: "Topic recall", name: "'you told me about'", message: "You told me about laptops for programming, remember?", recalled: ["laptop"] },
  { category: "Topic recall", name: "'what did you recommend'", message: "What did you recommend for Postgres hosting?", recalled: ["pg"] },
  { category: "Topic recall", name: "'what we said about'", message: "Remind me what we said about flights to Delhi", recalled: ["flight"] },
  { category: "Topic recall", name: "'the shortlist we made'", message: "Which was the cheapest in the CRM shortlist we made?", recalled: ["crm"] },
  { category: "Topic recall", name: "word from the summary title", message: "What was that dal recipe you gave me?", recalled: ["dal"] },
  { category: "Topic recall", name: "word variant (explained/operator)", message: "Earlier you explained a TypeScript operator to me. Which one?", recalled: ["ts"] },
  { category: "Topic recall", name: "paraphrase, no shared words (laptop)", message: "What notebook computer did you suggest?", recalled: ["laptop"] },
  { category: "Topic recall", name: "paraphrase, no shared words (flights)", message: "What did you say about airfare to the capital?", recalled: ["flight"] },

  // Nothing to find: the context must say so plainly.
  { category: "Missing history", name: "empty memory", message: "What did I ask you on 3 November?", history: [], recalled: [], context: [/no earlier conversations are recorded/] },
  { category: "Missing history", name: "date with no record, nearest offered", message: "What did I ask you on 1 November?", recalled: [], context: [/Sun 1 Nov 2026: nothing was recorded/, /Nearest recorded turns: Sat 24 Oct 2026.*Tue 3 Nov 2026/] },
  { category: "Missing history", name: "yesterday, nothing recorded", message: "What did I ask you yesterday?", recalled: [], context: [/Wed 11 Nov 2026: nothing was recorded/] },
  { category: "Missing history", name: "weekday with nothing recorded", message: "What did I ask you last Saturday?", recalled: [], context: [NOTHING] },
  { category: "Missing history", name: "whole month with nothing recorded", message: "What did I ask you in September?", recalled: [], context: [NOTHING] },
  { category: "Missing history", name: "wrong day, right topic", message: "Last Friday I asked you about Postgres hosting. Any changes?", recalled: ["ts", "pg"], context: [/Related by topic/] },

  // Ordinary messages must not drag old answers into the prompt.
  { category: "No recall needed", name: "general knowledge", message: "What is the capital of Australia?", recalled: [], notContext: [LOOKUP] },
  { category: "No recall needed", name: "a date about the world, not about us", message: "What happened in the stock market on Monday?", notContext: [QUOTED] },
  { category: "No recall needed", name: "a future date", message: "Remind me next Monday to call the bank", recalled: [], notContext: [LOOKUP] },
  { category: "No recall needed", name: "fresh question on a known topic", message: "Is Supabase Pro still $25 a month?", recalled: [] },
  { category: "No recall needed", name: "'I need' is not past tense", message: "I need a good CRM for a small team", recalled: [] },
  { category: "No recall needed", name: "small talk", message: "Thanks, that helps!", recalled: [] },
  { category: "No recall needed", name: "technical question", message: "How does HTTP caching work?", recalled: [] },

  // The same instant is a different calendar day in different places.
  { category: "Timezone", name: "'yesterday' in Bengaluru", message: "What did I ask you yesterday?", now: TZ_NOW, history: TZ_HISTORY, recalled: ["office"] },
  { category: "Timezone", name: "'yesterday' in Los Angeles", message: "What did I ask you yesterday?", now: TZ_NOW, timezone: "America/Los_Angeles", history: TZ_HISTORY, recalled: [] },
  { category: "Timezone", name: "'earlier today' in Los Angeles", message: "What did I ask you earlier today?", now: TZ_NOW, timezone: "America/Los_Angeles", history: TZ_HISTORY, recalled: ["office"] },
  { category: "Timezone", name: "'earlier today' in Bengaluru", message: "What did I ask you earlier today?", now: TZ_NOW, history: TZ_HISTORY, recalled: [] },
];
