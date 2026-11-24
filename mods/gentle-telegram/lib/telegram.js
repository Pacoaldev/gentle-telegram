// Telegram, as data: the bot URL, the long-poll body, what an update means and what the keyboard
// carries. Nothing here talks to the network, so the wire rules are testable without a bot token.
//
// The two rules that matter and are easy to get wrong:
// - A callback button names its option by *index* (`gt:<index>:<toolCallId>`), because the desktop
//   action `answer_question` takes an option index and the label is only for the human (S2).
// - The tool call id is carried in the button data, so a tap answers the question it was sent for
//   even when the session has moved on to another one.

export const API_BASE = "https://api.telegram.org";
/** Long poll window, clamped: Telegram accepts 0..50 seconds. */
export const POLL_TIMEOUT_MAX = 50;
export const POLL_TIMEOUT_DEFAULT = 25;
/** The desktop feed carries at most ten options; a keyboard never carries more. */
export const MAX_OPTIONS = 10;
/** NOX9GO hub reply-keyboard labels: the MOD must not relay them as Gentle Shell orders. */
export const NOX9GO_HUB_REPLY_LABELS = new Set(["📋 Menú", "🔄 Modo", "⌨️ Teclado"]);
const CALLBACK_PREFIX = "gt:";
const LABEL_MAX = 60;
const TEXT_MAX = 4000;

export function apiUrl(token, method) {
  const t = typeof token === "string" ? token.trim() : "";
  if (!t) throw new Error("A Telegram bot token is required.");
  if (typeof method !== "string" || !method) throw new Error("A Telegram method is required.");
  return `${API_BASE}/bot${t}/${method}`;
}

/** The body of `getUpdates`: a long poll that only asks for what this bridge reads. */
export function getUpdatesBody({ offset = null, timeout = POLL_TIMEOUT_DEFAULT } = {}) {
  const seconds = Math.min(Math.max(Math.trunc(Number(timeout) || 0), 0), POLL_TIMEOUT_MAX);
  const body = { timeout: seconds, allowed_updates: ["message", "callback_query"] };
  if (Number.isInteger(offset) && offset > 0) body.offset = offset;
  return body;
}

/**
 * One update as this bridge understands it, or null for anything else (a sticker, an edit, a
 * callback that is not ours). A callback and a message are the only two shapes it acts on.
 */
export function decodeUpdate(update) {
  const u = update && typeof update === "object" ? update : null;
  if (!u) return null;
  const message = u.message;
  if (message && typeof message === "object") {
    const chatId = message.chat?.id;
    const messageId = message.message_id;
    if (typeof chatId !== "number" || typeof messageId !== "number") return null;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text) return null;
    return { kind: "message", chatId, messageId, text, relay: isRelayOrderText(text) };
  }
  const query = u.callback_query;
  if (query && typeof query === "object") {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (typeof chatId !== "number" || typeof messageId !== "number") return null;
    const parsed = decodeCallbackData(query.data);
    if (!parsed) return null;
    return {
      kind: "callback", chatId, messageId, option: parsed.option, toolCallId: parsed.toolCallId,
      callbackId: typeof query.id === "string" ? query.id : null,
    };
  }
  return null;
}

export function encodeCallbackData(option, toolCallId) {
  return `${CALLBACK_PREFIX}${option}:${toolCallId}`;
}

/** `{ option, toolCallId }` or null; the tool call id may itself contain a colon. */
export function decodeCallbackData(data) {
  if (typeof data !== "string" || !data.startsWith(CALLBACK_PREFIX)) return null;
  const rest = data.slice(CALLBACK_PREFIX.length);
  const at = rest.indexOf(":");
  if (at < 0) return null;
  const digits = rest.slice(0, at);
  const toolCallId = rest.slice(at + 1);
  if (!/^\d+$/.test(digits) || !toolCallId) return null;
  const option = Number(digits);
  if (!Number.isInteger(option) || option < 0 || option > 63) return null;
  return { option, toolCallId };
}

/** What a button says: the option's label, else its description, else "Option N". */
function buttonLabel(option, index) {
  const label = typeof option?.label === "string" ? option.label.trim() : "";
  if (label) return label.slice(0, LABEL_MAX);
  const description = typeof option?.description === "string" ? option.description.trim() : "";
  return (description || `Option ${index + 1}`).slice(0, LABEL_MAX);
}

/**
 * The inline keyboard of one question: one button per option, one column up to four options and
 * two per row above that (a column of ten rows does not scroll well on a phone).
 */
export function inlineKeyboard(options, toolCallId) {
  const list = Array.isArray(options) ? options.slice(0, MAX_OPTIONS) : [];
  const buttons = list.map((option, index) => ({ text: buttonLabel(option, index), callback_data: encodeCallbackData(index, toolCallId) }));
  const perRow = buttons.length <= 4 ? 1 : 2;
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return { inline_keyboard: rows };
}

/** The Telegram message of a blocker: what is asked, where, and every option with its number. */
export function blockerText(pending) {
  const question = typeof pending?.question === "string" ? pending.question.trim() : "";
  if (!question) return "";
  const where = [pending.sessionName, pending.cwd].filter((v) => typeof v === "string" && v).join(" · ");
  const lines = [`⏳ Gentle Shell awaits: ${where || pending.sessionId || "a session"}`];
  if (typeof pending.header === "string" && pending.header.trim()) lines.push(pending.header.trim());
  lines.push(question);
  const options = Array.isArray(pending.options) ? pending.options.slice(0, MAX_OPTIONS) : [];
  options.forEach((option, index) => lines.push(`${index + 1}. ${buttonLabel(option, index)}`));
  lines.push("Tap a button to answer, or send text to relay an order to this session.");
  return lines.join("\n");
}

/** How the bridge echoes an order it relayed. */
export function orderText(text, sessionName) {
  const to = typeof sessionName === "string" && sessionName ? sessionName : "Gentle Shell";
  return `→ ${to}: ${safeText(text).slice(0, TEXT_MAX).trim()}`;
}

/** The ids a written allowlist names, in order. Anything that is not an integer is not an id. */
function chatIds(allowlist) {
  return String(allowlist ?? "")
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));
}

/** An empty allowlist allows nobody: the bridge is never open to whoever finds the bot. */
export function isAllowedChat(chatId, allowlist) {
  if (!Number.isInteger(chatId)) return false;
  return chatIds(allowlist).includes(chatId);
}

/** Control characters never reach Telegram or a session: new lines and tabs stay. */
export function safeText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "") : "";
}

/**
 * May this chat talk to the bridge? A written allowlist decides on its own. Without one the first
 * chat that writes becomes the operator's and is remembered, so the pump can be primed by sending
 * the bot a message — and a second stranger cannot take it over.
 */
export function chooseChat(state, allowlist, chatId) {
  if (!Number.isInteger(chatId)) return false;
  const list = String(allowlist ?? "").trim();
  if (list) return isAllowedChat(chatId, list);
  if (!state || typeof state !== "object") return false;
  if (!Number.isInteger(state.chatId)) {
    state.chatId = chatId;
    return true;
  }
  return state.chatId === chatId;
}

/**
 * The chat an outbound message goes to: the first id the written allowlist names, else the chat the
 * bridge learned from an incoming message, else null — nothing may be told before somebody writes.
 */
export function firstAllowedChat(allowlist, learned) {
  const first = chatIds(allowlist)[0];
  if (Number.isInteger(first)) return first;
  return Number.isInteger(learned) ? learned : null;
}

/**
 * Text that may run as a Gentle Shell order. Bot commands and the NOX9GO hub keyboard stay with
 * the gateway when both share a bot — this mod only forwards real prompts.
 */
export function isRelayOrderText(text) {
  const line = typeof text === "string" ? text.trim() : "";
  if (!line) return false;
  if (line.startsWith("/")) return false;
  if (NOX9GO_HUB_REPLY_LABELS.has(line)) return false;
  return true;
}

/** Herdr's in-process fetch can fail on Windows before Telegram answers (reqwest transport). */
export function telegramFetchFailedInHost(error) {
  const message = String(error && typeof error === "object" && "message" in error ? error.message : error ?? "");
  return /error sending request/i.test(message)
    || /^fetching https?:\/\//i.test(message)
    || /is not granted/i.test(message);
}

/** On Windows the mod uses curl first — one request, not fetch then curl (rate limits). */
export function telegramPreferCurlTransport() {
  return typeof process !== "undefined" && process.platform === "win32";
}

/** curl -m budget: long-poll getUpdates needs Telegram's timeout plus headroom. */
export function telegramCurlTimeoutSeconds(method) {
  return method === "getUpdates" ? 90 : 60;
}

/** Seconds to wait after a 429 refusal (from parameters or description). */
export function telegramRetryAfterSeconds(data, message = "") {
  const payload = data && typeof data === "object" ? data : null;
  const retry = payload?.parameters && typeof payload.parameters === "object"
    ? payload.parameters.retry_after
    : null;
  if (Number.isFinite(retry) && retry > 0) return retry;
  const fromMsg = String(message).match(/wait (\d+)s/i);
  return fromMsg ? Number(fromMsg[1]) : 0;
}

/** Turn Telegram's JSON refusal into one short line for the log (no token). */
export function telegramRefusalDetail(method, data, httpStatus) {
  const payload = data && typeof data === "object" ? data : null;
  if (payload && payload.error_code === 429) {
    const retry = payload.parameters && typeof payload.parameters === "object"
      ? payload.parameters.retry_after
      : null;
  const fromDescription = typeof payload.description === "string"
    ? payload.description.match(/retry after (\d+)/i)
    : null;
    const seconds = Number.isFinite(retry) ? retry : fromDescription ? Number(fromDescription[1]) : null;
    if (Number.isFinite(seconds) && seconds > 0) {
      return `Too many requests on ${method}; wait ${seconds}s and try again.`;
    }
  }
  if (payload && typeof payload.description === "string" && payload.description.trim()) {
    return payload.description.trim();
  }
  return `HTTP ${httpStatus ?? "?"}`;
}
