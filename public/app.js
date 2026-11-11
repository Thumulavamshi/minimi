// The chat page. Plain browser JavaScript: no framework and no build step.
/* global marked, DOMPurify */

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const el = {
  thread: document.getElementById("thread"),
  scroll: document.getElementById("scroll"),
  conversations: document.getElementById("conversations"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  notice: document.getElementById("notice"),
  modelNote: document.getElementById("model-note"),
  newChat: document.getElementById("new-chat"),
};

const state = {
  conversationId: null,
  /** Set while an answer is streaming; aborting it stops the answer. */
  abort: null,
};

const EXAMPLES = [
  "Which managed Postgres hosts have a free tier right now, and what are the limits?",
  "What did I ask you yesterday? Is your answer still correct today?",
  "What changed in the latest Node.js release?",
];

// ---------- small helpers ----------

function node(tag, className, text) {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

function formatWhen(ms) {
  return new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Markdown to safe HTML. The answer contains text from the web, so it is sanitised. */
function renderMarkdown(target, markdown) {
  target.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { breaks: false, gfm: true }));
  for (const link of target.querySelectorAll("a")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    // The agent writes each citation as [1](url); show those as small numbered badges.
    if (/^\d+$/.test(link.textContent.trim())) link.classList.add("cite");
  }
}

function nearBottom() {
  return el.scroll.scrollHeight - el.scroll.scrollTop - el.scroll.clientHeight < 120;
}

function scrollToBottom() {
  el.scroll.scrollTop = el.scroll.scrollHeight;
}

// ---------- rendering a turn ----------

/** How each result of the app's link check is shown beside a source. */
const ORIGINS = {
  search: { mark: "✓", note: "This page was returned by this answer's web search." },
  memory: { mark: "↺", note: "This page was cited in an earlier answer that the agent recalled." },
  site: { mark: "~", note: "The search returned this site, but not this exact page." },
  unlisted: { mark: "?", note: "This link was not among the search results. The model supplied it, so check it before relying on it." },
};

/** Builds the elements for one assistant reply and returns handles to update them. */
function assistantView() {
  const root = node("div", "assistant");
  const steps = node("details", "steps");
  const summary = node("summary");
  const list = node("ul");
  const context = node("pre");
  steps.append(summary, list, context);
  steps.hidden = true;
  const live = node("div", "live", "Thinking");
  const body = node("div", "body");
  const sources = node("ul", "sources");
  const foot = node("div", "foot");
  root.append(steps, live, body, sources, foot);
  el.thread.append(root);

  const view = {
    root,
    recalled: 0,
    addStep(text) {
      list.append(node("li", null, text));
    },
    setLive(text) {
      live.textContent = text;
    },
    setBody(markdown) {
      renderMarkdown(body, markdown);
    },
    addSource(source) {
      const item = node("li");
      const origin = ORIGINS[source.origin];
      const link = node("a", origin ? `origin-${source.origin}` : null, `${origin ? `${origin.mark} ` : ""}${source.n}. ${source.title}`);
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = [source.url, origin?.note, source.excerpt && `Search excerpt: ${source.excerpt}`].filter(Boolean).join("\n\n");
      item.append(link);
      sources.append(item);
    },
    showProblem(message) {
      root.append(node("div", "problem", message));
    },
    /** Called once the turn is stored: fold the live steps into a one-line summary. */
    finish(turn) {
      live.remove();
      if (!turn) return;
      const parts = [];
      if (view.recalled) parts.push(`recalled ${view.recalled} earlier ${view.recalled === 1 ? "turn" : "turns"}`);
      if (turn.searches.length) parts.push(`${turn.searches.length} web ${turn.searches.length === 1 ? "search" : "searches"}`);
      summary.textContent = parts.length ? `How this was answered: ${parts.join(", ")}` : "How this was answered: from memory and general knowledge";
      // The result of checking each cited link against what was retrieved.
      const count = (origin) => turn.sources.filter((s) => s.origin === origin).length;
      const checked = [
        count("search") && `${count("search")} from this answer's search results`,
        count("memory") && `${count("memory")} carried over from an earlier answer`,
        count("site") && `${count("site")} on a searched site but a different page`,
        count("unlisted") && `${count("unlisted")} not found in the search results`,
      ].filter(Boolean);
      if (checked.length) view.addStep(`Link check: ${checked.join(", ")}`);
      // Facts recorded from this answer for later re-checking (written just after the answer).
      for (const claim of turn.digest?.claims ?? []) view.addStep(`Recorded for re-checking: ${claim.text}`);
      context.textContent = `What the model was given before your message:\n\n${turn.contextNote}`;
      steps.hidden = false;

      const stats = [];
      if (turn.stats.totalMs) stats.push(`answered in ${seconds(turn.stats.totalMs)}`);
      if (turn.stats.firstTokenMs) stats.push(`first words after ${seconds(turn.stats.firstTokenMs)}`);
      if (turn.stats.inputTokens) stats.push(`${turn.stats.cachedTokens ?? 0} of ${turn.stats.inputTokens} prompt tokens read from cache`);
      if (turn.status !== "complete") stats.push("stopped early");
      if (turn.stats.seeded) stats.push("demo history added by npm run seed");
      foot.textContent = stats.join(" · ");
    },
  };
  return view;
}

function showUserMessage(text, when) {
  el.thread.append(node("div", "stamp", formatWhen(when)), node("div", "user", text));
}

/** Draws a turn loaded from storage. */
function showStoredTurn(turn) {
  showUserMessage(turn.question, turn.createdAt);
  const view = assistantView();
  for (const query of turn.searches) view.addStep(`Searched the web: ${query}`);
  view.setBody(turn.answer);
  for (const source of turn.sources) view.addSource(source);
  view.finish(turn);
}

function showWelcome(followUps) {
  const box = node("div", "welcome");
  box.append(node("h1", null, "What would you like to know?"));
  box.append(
    node(
      "p",
      null,
      "I search the web for anything that might have changed, and I keep a dated record of what you asked and what I answered, so you can ask later whether it is still true.",
    ),
  );
  const addChips = (heading, items) => {
    box.append(node("h2", null, heading));
    const chips = node("div", "chips");
    for (const item of items) {
      const chip = node("button", "chip", item.label);
      chip.type = "button";
      chip.addEventListener("click", () => send(item.prompt));
      chips.append(chip);
    }
    box.append(chips);
  };
  // Earlier answers that rested on facts which go stale. Nothing is searched until one is clicked.
  if (followUps.length) addChips("Worth re-checking", followUps.map((f) => ({ label: `${f.label}: is it still correct?`, prompt: f.prompt })));
  addChips("Try asking", EXAMPLES.map((text) => ({ label: text, prompt: text })));
  el.thread.replaceChildren(box);
}

// ---------- talking to the server ----------

async function refreshSidebar() {
  const response = await fetch(`/api/state?tz=${encodeURIComponent(TIMEZONE)}`);
  const data = await response.json();
  el.conversations.replaceChildren(
    ...data.conversations.map((conversation) => {
      const row = node("div", `conversation${conversation.id === state.conversationId ? " active" : ""}`);
      const open = node("button", "open");
      open.type = "button";
      open.append(node("span", "title", conversation.title), node("span", "when", formatWhen(conversation.updatedAt)));
      open.addEventListener("click", () => openConversation(conversation.id));
      const remove = node("button", "remove", "×");
      remove.type = "button";
      remove.title = "Delete this conversation";
      remove.addEventListener("click", async () => {
        if (!confirm(`Delete "${conversation.title}"? The agent will no longer remember it.`)) return;
        await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
        if (state.conversationId === conversation.id) await startNewChat();
        else await refreshSidebar();
      });
      row.append(open, remove);
      return row;
    }),
  );
  el.modelNote.textContent = `Model: ${data.model}`;
  el.notice.hidden = data.hasApiKey;
  el.notice.textContent = "No GROQ_API_KEY is set. Copy .env.example to .env, add your key, and restart the server.";
  return data;
}

async function openConversation(id) {
  if (state.abort) return;
  const response = await fetch(`/api/conversations/${id}`);
  if (!response.ok) return startNewChat();
  const data = await response.json();
  state.conversationId = id;
  el.thread.replaceChildren();
  for (const turn of data.turns) showStoredTurn(turn);
  scrollToBottom();
  await refreshSidebar();
}

async function startNewChat() {
  if (state.abort) return;
  state.conversationId = null;
  const data = await refreshSidebar();
  showWelcome(data.followUps);
  el.input.focus();
}

/** Reads the server's event stream and calls `onEvent` for each event. */
async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

async function send(text) {
  const message = text.trim();
  if (!message || state.abort) return;

  if (!state.conversationId) el.thread.replaceChildren();
  showUserMessage(message, Date.now());
  const view = assistantView();
  scrollToBottom();

  el.input.value = "";
  resizeInput();
  state.abort = new AbortController();
  el.send.textContent = "Stop";

  let answer = "";
  let drawQueued = false;
  let finished = null;
  // Re-rendering Markdown on every token is wasteful, so draw at most once per frame.
  const draw = () => {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      const stick = nearBottom();
      view.setBody(answer);
      if (stick) scrollToBottom();
    });
  };

  const onEvent = (event) => {
    switch (event.type) {
      case "start":
        state.conversationId = event.conversationId;
        for (const date of event.dates) view.addStep(`Read "${date.phrase}" as ${date.label}`);
        for (const past of event.recalled) {
          view.addStep(`Recalled ${past.when}: "${past.question}" (${past.reason})`);
          for (const claim of past.claims) view.addStep(`Claim to re-check: ${claim}`);
        }
        view.recalled = event.recalled.length;
        if (event.recalled.length) view.setLive(`Recalled ${event.recalled.length} earlier ${event.recalled.length === 1 ? "turn" : "turns"}`);
        break;
      case "activity":
        if (event.kind === "thinking") view.setLive("Thinking");
        if (event.kind === "searching") {
          view.setLive(event.detail ? `Searching the web: ${event.detail}` : "Searching the web");
          if (event.detail) view.addStep(`Searched the web: ${event.detail}`);
        }
        if (event.kind === "reading") {
          view.setLive(`Reading ${event.detail}`);
          view.addStep(`Read results from ${event.detail}`);
        }
        break;
      case "text":
        answer += event.text;
        view.setLive("Writing");
        draw();
        break;
      case "source":
        view.addSource(event.source);
        break;
      case "done":
        finished = event.turn;
        break;
      case "error":
        view.showProblem(event.message);
        break;
    }
  };

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, conversationId: state.conversationId, timezone: TIMEZONE }),
      signal: state.abort.signal,
    });
    if (!response.ok) throw new Error((await response.json()).error ?? "The server refused the message.");
    await readEvents(response, onEvent);
  } catch (error) {
    if (error.name !== "AbortError") view.showProblem(error.message);
  }

  view.setBody(answer);
  view.finish(finished);
  state.abort = null;
  el.send.textContent = "Send";
  el.input.focus();
  await refreshSidebar();
  // The conversation's title is written a moment after the answer; pick it up.
  setTimeout(refreshSidebar, 4000);
}

// ---------- wiring ----------

function resizeInput() {
  el.input.style.height = "auto";
  el.input.style.height = `${el.input.scrollHeight}px`;
}

el.input.addEventListener("input", resizeInput);
el.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    el.composer.requestSubmit();
  }
});
el.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.abort) state.abort.abort();
  else send(el.input.value);
});
el.newChat.addEventListener("click", startNewChat);

startNewChat();
