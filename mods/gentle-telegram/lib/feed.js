// The Gentle Shell desktop feed, read as a question to answer (S1, S2).
//
// What NOX9GO proved on a real machine (docs/TELEGRAM_GENTLE_SHELL.md §14): `herdr agent read`
// reports `idle` while a Pi session has an open question, and the truth is the session's own
// snapshot under `<agentDir>/desktop/sessions/<sessionId>.json`. So the blocker is the snapshot
// with `activity.state` in blocked|waiting and a `pendingQuestion` that carries options.
//
// Only the fields this mod needs are read, and every one of them is validated: a snapshot that
// does not answer all of them is not a blocker instead of a half-built Telegram message.

export const FEED_SCHEMA = "gentle-shell.desktop-feed/v1";
/** The feed carries at most ten options (desktop-feed limits.options). */
export const MAX_OPTIONS = 10;
const BLOCKED_STATES = new Set(["blocked", "waiting"]);

export function isBlocked(state) {
  return BLOCKED_STATES.has(state);
}

const str = (value) => (typeof value === "string" ? value.trim() : "");

/** Is this an absolute path on either platform? A relative one names no session's folder. */
function isAbsolutePath(value) {
  return typeof value === "string" && (value.startsWith("/") || /^[A-Za-z]:[/\\]/.test(value));
}

/**
 * Every option of the question, in order, or null when one of them could not be shown as a button
 * (an option with no label is not answerable by index, so the whole question stays in the TUI).
 */
function normalizeOptions(options) {
  if (!Array.isArray(options) || options.length === 0) return null;
  const out = [];
  for (const option of options.slice(0, MAX_OPTIONS)) {
    const label = str(option?.label);
    if (!label) return null;
    out.push({ label, description: str(option?.description) });
  }
  return out.length ? out : null;
}

/** The question this snapshot waits for, ready for Telegram; null when it waits for nothing. */
export function pendingFrom(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const schema = snapshot.schema;
  if (typeof schema === "string" && schema && schema !== FEED_SCHEMA) return null;
  const identity = snapshot.identity && typeof snapshot.identity === "object" ? snapshot.identity : {};
  const activity = snapshot.activity && typeof snapshot.activity === "object" ? snapshot.activity : {};
  if (!isBlocked(activity.state)) return null;
  const question = snapshot.pendingQuestion;
  if (!question || typeof question !== "object") return null;
  const toolCallId = str(question.toolCallId);
  const text = str(question.question);
  if (!toolCallId || !text) return null;
  const options = normalizeOptions(question.options);
  if (!options) return null;
  const sessionId = str(identity.sessionId);
  return {
    sessionId,
    sessionName: str(identity.sessionName) || null,
    cwd: str(identity.cwd) || null,
    agentDir: isAbsolutePath(identity.agentDir) ? str(identity.agentDir).replace(/[/\\]+$/, "") : null,
    toolCallId,
    question: text,
    header: str(question.header) || null,
    state: activity.state,
    options,
  };
}

/** The dedup signature NOX9GO uses for a feed blocker: the tool call is the identity. */
export function feedSignature(pending) {
  const toolCallId = str(pending?.toolCallId);
  return toolCallId ? `gentle-feed:${toolCallId}` : null;
}

/**
 * The question to send, out of every session's snapshot: the newest one that has a blocker. Each
 * entry is `{ snapshot, mtimeMs }` as read from disk; the newest file wins, ties keep the order.
 */
export function pickPending(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let best = null;
  let bestAt = -1;
  for (const entry of list) {
    const snapshot = entry?.snapshot;
    const pending = pendingFrom(snapshot);
    if (!pending) continue;
    const at = Number.isFinite(entry?.mtimeMs) ? entry.mtimeMs : 0;
    if (best === null || at > bestAt) {
      best = pending;
      bestAt = at;
    }
  }
  return best;
}

/**
 * The newest session an order can be typed into: any live snapshot whose identity names both a
 * session and the agent dir that holds its inbox. A blocker is not required — an order is for a
 * session that is working, not only for one that is stuck.
 */
export function newestSession(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let best = null;
  let bestAt = -1;
  for (const entry of list) {
    const identity = entry?.snapshot?.identity;
    if (!identity || typeof identity !== "object") continue;
    const sessionId = str(identity.sessionId);
    if (!sessionId) continue;
    if (!isAbsolutePath(identity.agentDir)) continue;
    const at = Number.isFinite(entry?.mtimeMs) ? entry.mtimeMs : 0;
    if (best === null || at > bestAt) {
      best = {
        sessionId,
        sessionName: str(identity.sessionName) || null,
        cwd: str(identity.cwd) || null,
        agentDir: str(identity.agentDir).replace(/[/\\]+$/, ""),
      };
      bestAt = at;
    }
  }
  return best;
}
