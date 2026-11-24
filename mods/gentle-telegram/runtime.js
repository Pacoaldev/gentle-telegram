// The bridge's wiring: Telegram over `fetch`, Gentle Shell over its own desktop files, Herdr for the
// terminal an order falls back to. Every rule it applies lives in ./lib, which is unit-tested; this
// file only moves data between the two sides and says what could not be done.
//
// Two host disciplines, both learned from gentle-chat:
// - Herdr's ambient calls (`shared`, `focused`, `home`) only count inside a host call. Take the
//   synchronous reading you need *before* the first `await` of a handler, never after it.
// - Everything async here ends in a value; the view turns it into UI inside `cx.timer.after`, so a
//   redraw never runs off the back of a network answer.
//
// Nothing in this file claims that a session accepted an action: the answer to a desktop action is
// the session's own outbox result, and a missing result is reported as missing (S6).

import { exec, hc, focused, terminals, home, readTextFile, writeTextFile, shared, setShared, watchFolder } from "herdr";
import { exists, readdir } from "fs/promises";
import {
  apiUrl, getUpdatesBody, chooseChat, safeText, telegramFetchFailedInHost, telegramCurlTimeoutSeconds,
  telegramRefusalDetail, telegramPreferCurlTransport, telegramRetryAfterSeconds, isTelegramWebhookConflict,
} from "./lib/telegram.js";
import { pickPending, newestSession } from "./lib/feed.js";
import { answerAction, promptAction, validateAction, inboxPath, outboxPath, parseActionResult } from "./lib/actions.js";
import { createState, noteSeen, pushEvent, advanceOffset, takePollerClaim, syncTokenScope, SEEN_MAX } from "./lib/state.js";

/** Settings keys, as declared in kit.json. */
export const SETTING = {
  token: "gentle-telegram.token",
  allowlist: "gentle-telegram.allowlist",
  poll: "gentle-telegram.poll",
  orders: "gentle-telegram.orders",
  details: "gentle-telegram.details",
};
const STATE_KEY = "gentle-telegram.state";
export const BRIDGES_MAX = 32;
/** The feed carries ten options at most, and a snapshot folder holds a session per file. */
const SNAPSHOT_MAX = 16;
const RECENCY_MAX = 128;
const POLL_TIMEOUT_S = 25;
const OUTBOX_WAIT_MS = 6000;
const OUTBOX_STEP_MS = 80;
const TEXT_MAX = 4000;

const env = (name) => (typeof process !== "undefined" && "env" in process && /** @type {any} */ (process).env ? /** @type {any} */ (process).env[name] : null);

export function errorText(error) {
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error ?? "");
  return message.trim() || "the bridge failed without a message";
}

/** Everything kit.json writes, read once per host call. */
export function settings() {
  const token = shared(SETTING.token);
  const allowlist = shared(SETTING.allowlist);
  return {
    token: typeof token === "string" && token.trim() ? token.trim() : null,
    allowlist: typeof allowlist === "string" ? allowlist : (allowlist ? String(allowlist) : ""),
    poll: shared(SETTING.poll) !== false,
    orders: shared(SETTING.orders) !== false,
    details: shared(SETTING.details) !== false,
  };
}

/** The state that must outlive a reload: the offset, the blockers told, the open buttons. */
export function loadState() {
  const state = createState();
  state.bridges = [];
  state.chatId = null;
  state.rateLimitUntil = null;
  const saved = shared(STATE_KEY);
  if (!saved || typeof saved !== "object") return state;
  const raw = /** @type {Record<string, any>} */ (saved);
  if (Number.isInteger(raw.offset)) state.offset = raw.offset;
  if (typeof raw.tokenKey === "string") state.tokenKey = raw.tokenKey;
  if (Number.isInteger(raw.rateLimitUntil)) state.rateLimitUntil = raw.rateLimitUntil;
  if (Array.isArray(raw.seen)) state.seen = raw.seen.filter((s) => typeof s === "string").slice(-SEEN_MAX);
  if (Number.isInteger(raw.chatId)) state.chatId = raw.chatId;
  if (Array.isArray(raw.bridges)) {
    state.bridges = raw.bridges
      .filter((b) => b && typeof b === "object" && typeof b.toolCallId === "string" && typeof b.sessionId === "string")
      .slice(-BRIDGES_MAX);
  }
  return state;
}

export function saveState(state) {
  setShared(STATE_KEY, {
    offset: state.offset,
    tokenKey: state.tokenKey ?? null,
    seen: state.seen.slice(-SEEN_MAX),
    chatId: state.chatId ?? null,
    bridges: state.bridges.slice(-BRIDGES_MAX),
    rateLimitUntil: Number.isInteger(state.rateLimitUntil) ? state.rateLimitUntil : null,
  });
}

/** Remember which Telegram message carries which question, so a tap finds its session (S2). */
export function rememberBridge(state, { toolCallId, sessionId, agentDir, chatId, messageId }) {
  state.bridges = state.bridges.filter((b) => b.toolCallId !== toolCallId);
  state.bridges.push({ toolCallId, sessionId, agentDir, chatId, messageId });
  if (state.bridges.length > BRIDGES_MAX) state.bridges.splice(0, state.bridges.length - BRIDGES_MAX);
  return state.bridges.at(-1);
}

export function bridgeFor(state, toolCallId) {
  return state.bridges.find((b) => b.toolCallId === toolCallId) ?? null;
}

export function forgetBridge(state, toolCallId) {
  if (!state || !Array.isArray(state.bridges)) return;
  state.bridges = state.bridges.filter((b) => b.toolCallId !== toolCallId);
}

// --- Telegram ---------------------------------------------------------------------------------

const CURL = typeof process !== "undefined" && process.platform === "win32" ? "curl.exe" : "curl";

/** ponytail: Herdr fetch transport is broken on some Windows builds; curl uses the OS stack. */
async function callViaCurl(url, method) {
  const seconds = telegramCurlTimeoutSeconds(method);
  const args = ["-sS", "-m", String(seconds), url];
  try {
    const { code, stdout, stderr } = await exec(CURL, args, { timeout: (seconds + 15) * 1000 });
    if (code !== 0) {
      throw new Error((stderr || stdout || `curl exit ${code}`).trim());
    }
    return stdout;
  } catch (error) {
    if (!telegramPreferCurlTransport()) throw error;
    return callViaPowerShell(url, "GET", undefined);
  }
}

/** POST getUpdates/sendMessage through curl when fetch cannot open the TLS socket. */
async function callViaCurlPost(url, method, body) {
  const seconds = telegramCurlTimeoutSeconds(method);
  const args = [
    "-sS", "-m", String(seconds), "-X", "POST",
    "-H", "content-type: application/json",
    "-d", JSON.stringify(body),
    url,
  ];
  try {
    const { code, stdout, stderr } = await exec(CURL, args, { timeout: (seconds + 15) * 1000 });
    if (code !== 0) {
      throw new Error((stderr || stdout || `curl exit ${code}`).trim());
    }
    return stdout;
  } catch (error) {
    if (!telegramPreferCurlTransport()) throw error;
    return callViaPowerShell(url, "POST", body);
  }
}

/** When curl from Herdr exec stalls, PowerShell uses the same stack as a manual probe. */
async function callViaPowerShell(url, method, body) {
  const seconds = telegramCurlTimeoutSeconds(method);
  const safeUrl = url.replace(/'/g, "''");
  const jsonBody = body === undefined ? null : JSON.stringify(body).replace(/'/g, "''");
  const command = jsonBody === null
    ? `$r = Invoke-RestMethod -Uri '${safeUrl}' -Method Get -TimeoutSec ${seconds}; $r | ConvertTo-Json -Depth 8 -Compress`
    : `$r = Invoke-RestMethod -Uri '${safeUrl}' -Method Post -ContentType 'application/json' -Body '${jsonBody}' -TimeoutSec ${seconds}; $r | ConvertTo-Json -Depth 8 -Compress`;
  const { code, stdout, stderr } = await exec("powershell.exe", ["-NoProfile", "-Command", command], {
    timeout: (seconds + 20) * 1000,
  });
  if (code !== 0) {
    throw new Error(`Telegram transport failed: ${(stderr || stdout || "PowerShell request failed").trim()}`);
  }
  return stdout.trim();
}

function parseTelegramBody(method, raw, httpStatus) {
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (!data || data.ok !== true) {
    const detail = telegramRefusalDetail(method, data, httpStatus);
    const err = new Error(`Telegram refused ${method}: ${detail}`);
    const wait = telegramRetryAfterSeconds(data, detail);
    if (wait > 0) /** @type {any} */ (err).retryAfterSeconds = wait;
    throw err;
  }
  return data.result;
}

export function noteRateLimit(state, error) {
  const wait = error && typeof error === "object" && Number.isFinite(error.retryAfterSeconds)
    ? error.retryAfterSeconds
    : telegramRetryAfterSeconds(null, errorText(error));
  if (wait > 0) state.rateLimitUntil = Date.now() + wait * 1000 + 500;
}

export function clearRateLimit(state) {
  if (state && typeof state === "object") state.rateLimitUntil = null;
}

export function rateLimitRemainingSeconds(state) {
  if (!state || !Number.isInteger(state.rateLimitUntil)) return 0;
  const left = Math.ceil((state.rateLimitUntil - Date.now()) / 1000);
  return left > 0 ? left : 0;
}

/** How long the poll loop should sleep after a failed Telegram call (honours 429 retry_after). */
export function pollBackoffMs(state, error, fallbackMs = 5000) {
  if (error) noteRateLimit(state, error);
  const sec = rateLimitRemainingSeconds(state);
  if (sec > 0) return sec * 1000 + 500;
  return fallbackMs;
}

async function call(token, method, body) {
  const url = apiUrl(token, method);
  let raw;
  let httpStatus = null;
  if (telegramPreferCurlTransport()) {
    raw = body === undefined ? await callViaCurl(url, method) : await callViaCurlPost(url, method, body);
    return parseTelegramBody(method, raw, null);
  }
  try {
    const response = body === undefined
      ? await fetch(url)
      : await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    httpStatus = response.status;
    raw = await response.text();
  } catch (error) {
    if (!telegramFetchFailedInHost(error)) throw error;
    raw = body === undefined ? await callViaCurl(url, method) : await callViaCurlPost(url, method, body);
    httpStatus = null;
  }
  return parseTelegramBody(method, raw, httpStatus);
}

/** Drop any webhook so long-poll `getUpdates` is allowed (harmless when none was set). */
export async function deleteWebhook(token) {
  await call(token, "deleteWebhook", { drop_pending_updates: false });
}

export async function getMe(token) {
  const me = await call(token, "getMe");
  return { username: me && typeof me.username === "string" ? me.username : null, id: me?.id ?? null };
}

/** One long poll. Telegram hands back the updates after `offset`, never the same one twice. */
export async function getUpdates(token, offset) {
  const result = await call(token, "getUpdates", getUpdatesBody({ offset, timeout: POLL_TIMEOUT_S }));
  return Array.isArray(result) ? result : [];
}

const POLLER_KEY = "gentle-telegram.poller";

/**
 * Ask to own the poll, in `shared` so every view of this mod sees the same claim. Called once per
 * cycle: a holder refreshes its heartbeat, a stranded loop's claim expires and is taken over, and
 * a second live view waits instead of fighting Telegram over the one `getUpdates`.
 */
export function claimPoller(ownerId) {
  const current = shared(POLLER_KEY);
  const claim = takePollerClaim(current, ownerId, Date.now());
  if (!claim) return false;
  setShared(POLLER_KEY, claim);
  return true;
}

export async function sendMessage(token, chatId, text, keyboard) {
  const body = { chat_id: chatId, text: safeText(text).slice(0, TEXT_MAX), disable_web_page_preview: true };
  if (keyboard) body.reply_markup = keyboard;
  return call(token, "sendMessage", body);
}

/** The answer is written back over the question, and its buttons are taken away. */
export async function editMessage(token, chatId, messageId, text) {
  return call(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: safeText(text).slice(0, TEXT_MAX),
    reply_markup: { inline_keyboard: [] },
  });
}

export async function answerCallback(token, callbackId, text) {
  if (typeof callbackId !== "string" || !callbackId) return null;
  const body = { callback_query_id: callbackId };
  if (text) body.text = safeText(text).slice(0, 200);
  return call(token, "answerCallbackQuery", body);
}

/** May this chat use the bridge? A written allowlist wins; without one, the first chat is learned. */
export function admit(state, allowlist, chatId) {
  const before = state.chatId;
  const allowed = chooseChat(state, allowlist, chatId);
  return { allowed, learned: before !== state.chatId ? state.chatId : null };
}

// --- Gentle Shell desktop feed ----------------------------------------------------------------

/** Where a Gentle Shell keeps its sessions: the settings of Herdr, plus the two known folders. */
export function agentDirs() {
  const dirs = [];
  const push = (value) => {
    if (typeof value !== "string" || !value.trim()) return;
    const dir = value.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!dirs.includes(dir)) dirs.push(dir);
  };
  push(env("GENTLE_SHELL_AGENT_DIR"));
  let root = env("GENTLE_SHELL_HOME") || env("USERPROFILE") || env("HOME");
  if (!root) {
    try {
      root = home();
    } catch {
      root = null;
    }
  }
  if (root) {
    push(`${String(root).replace(/\\/g, "/").replace(/\/+$/, "")}/.gentle-shell/agent`);
    push(`${String(root).replace(/\\/g, "/").replace(/\/+$/, "")}/.pi/agent`);
  }
  return dirs;
}

/**
 * Every session snapshot on this machine, newest first: `{ snapshot, mtimeMs, path, agentDir }`.
 * A folder that does not exist is not an error (a Gentle Shell that never ran), and a file that
 * does not parse is skipped rather than reported as a blocker.
 *
 * The filesystem module a mod gets has no `stat`, so "newest" comes from two honest sources: the
 * recency the folder watch learned (a file that changed is stamped with the moment it was seen),
 * and a timestamp inside the snapshot when it carries one.
 */
export async function scanFeed(dirs = agentDirs(), recency = new Map()) {
  const entries = [];
  for (const agentDir of dirs) {
    const folder = `${agentDir}/desktop/sessions`;
    let names = [];
    try {
      names = await readdir(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (typeof name !== "string" || !name.endsWith(".json")) continue;
      const path = `${folder}/${name}`;
      let raw = null;
      try {
        raw = await readTextFile(path);
      } catch {
        continue; // a file that vanished between the listing and the read is not there
      }
      let snapshot = null;
      try {
        snapshot = raw ? JSON.parse(raw) : null;
      } catch {
        snapshot = null;
      }
      if (!snapshot || typeof snapshot !== "object") continue;
      entries.push({ snapshot, path, agentDir, mtimeMs: stampOf(snapshot, recency.get(path) ?? 0) });
    }
  }
  return entries
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.path.localeCompare(b.path))
    .slice(0, SNAPSHOT_MAX);
}

/** How recent a snapshot is: what the watch saw, or a time the snapshot itself carries. */
function stampOf(snapshot, fromWatch) {
  for (const value of [snapshot.updatedAt, snapshot.updated_at, snapshot.activity?.at, snapshot.activity?.updatedAt]) {
    const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(at)) return Math.max(at, fromWatch);
  }
  return fromWatch;
}

/** The recency of session files, learned from the folder watch (a mod cannot ask for a file's time). */
export function createRecency() {
  return new Map();
}

/** A folder watch said these files changed: they are the newest now. Bounded, oldest dropped. */
export function markChanged(recency, paths, at = Date.now()) {
  for (const path of paths ?? []) {
    if (typeof path !== "string" || !path) continue;
    recency.delete(path);
    recency.set(path, at);
  }
  while (recency.size > RECENCY_MAX) recency.delete(recency.keys().next().value);
  return recency;
}

/** The session folder of a Gentle Shell, watched so its changes give the feed its order. */
export function sessionsFolder(agentDir) {
  return `${agentDir}/desktop/sessions`;
}

export { watchFolder };

/** The question to send now, or null when no session waits for one. */
export function pendingOf(entries) {
  return pickPending(entries);
}

/** The session an order goes to when Telegram does not name one. */
export function orderTargetOf(entries) {
  const newest = newestSession(entries);
  if (!newest) return null;
  const entry = entries.find((e) => e.snapshot?.identity?.sessionId === newest.sessionId);
  return { ...newest, agentDir: entry?.agentDir ?? newest.agentDir };
}

// --- Desktop actions --------------------------------------------------------------------------

/**
 * Drop one action file in the session's inbox. An inbox that does not exist means the running
 * Gentle Shell cannot take desktop actions at all: that is said plainly, never papered over.
 */
export async function writeAction({ sessionId, agentDir }, action) {
  if (!agentDir) {
    return { ok: false, error: { code: "no_session", message: "That session names no agent folder, so it cannot be reached." } };
  }
  const check = validateAction(action);
  if (!check.ok) return check;
  const dir = inboxPath(agentDir, sessionId);
  if (!(await exists(dir))) {
    return { ok: false, error: { code: "no_inbox", message: "This session takes no desktop actions. Update Gentle Shell and restart it." } };
  }
  await writeTextFile(`${dir}/${action.id}.json`, JSON.stringify(action, null, 2), null);
  return { ok: true, error: null };
}

/**
 * The session's own answer, polled from its outbox. `sleep` is the host's timer, so this module
 * stays free of one. No result within the window is `null`: unknown, never success.
 */
export async function awaitResult({ sessionId, agentDir }, action, sleep, waitMs = OUTBOX_WAIT_MS, stepMs = OUTBOX_STEP_MS) {
  const path = outboxPath(agentDir, sessionId, action.id);
  const deadline = Date.now() + waitMs;
  for (;;) {
    let text = null;
    try {
      text = await readTextFile(path);
    } catch {
      text = null;
    }
    const parsed = parseActionResult(text, action.id);
    if (parsed) return parsed;
    if (Date.now() >= deadline) return null;
    await sleep(stepMs);
  }
}

/**
 * Answer one open question through the session, and report what the session said back.
 * @param {{ target: any, option?: any, text?: string, sleep: (ms: number) => Promise<any> | any }} params
 */
export async function answerQuestion({ target, option = undefined, text = undefined, sleep }) {
  const action = text !== undefined
    ? answerAction({ sessionId: target.sessionId, toolCallId: target.toolCallId, text })
    : answerAction({ sessionId: target.sessionId, toolCallId: target.toolCallId, option });
  const written = await writeAction(target, action);
  if (!written.ok) return { ok: false, error: written.error, action };
  const result = await awaitResult(target, action, sleep);
  if (!result) return { ok: false, error: { code: "no_result", message: "The session did not answer in time." }, action };
  return { ...result, action };
}

/** Relay a Telegram order as a prompt inside a session; returns where it went. */
export async function sendOrder({ target, fallbackAddress, text, sleep }) {
  const body = safeText(text).trim();
  if (!body) return { ok: false, error: { code: "empty", message: "An empty order is not sent." } };
  if (target) {
    const action = promptAction({ sessionId: target.sessionId, text: body });
    const written = await writeAction(target, action);
    if (written.ok) {
      const result = await awaitResult(target, action, sleep);
      return { ok: true, via: "session", sessionId: target.sessionId, accepted: result?.ok ?? null, action };
    }
    if (written.error?.code !== "no_inbox") return { ok: false, error: written.error, via: "session" };
    // No inbox: fall through to the terminal, which is the pre-desktop path.
  }
  if (!fallbackAddress) {
    return { ok: false, via: null, error: { code: "no_target", message: "No Gentle Shell session to send that order to." } };
  }
  const sent = await hc(["send", fallbackAddress, body]);
  if (sent.code !== 0) {
    return { ok: false, via: "terminal", error: { code: "send_failed", message: (sent.stderr || sent.stdout || "hc send failed").trim() } };
  }
  return { ok: true, via: "terminal", accepted: null };
}

/** The address of the terminal a fallback order goes to: the focused one, else the first live one. */
export function focusedAddress() {
  try {
    const here = focused();
    if (here && typeof here.terminal === "string" && here.terminal) return here.terminal;
    const all = terminals();
    for (const terminal of all) {
      if (terminal && typeof terminal.terminal === "string" && terminal.terminal) return terminal.terminal;
    }
  } catch {
    return null;
  }
  return null;
}

/** One line for the view's log, and the counter it belongs to. */
export function logEvent(state, kind, text, extra = {}) {
  return pushEvent(state, { kind, text: safeText(String(text ?? "")).slice(0, 400), ...extra });
}

export { noteSeen, advanceOffset, syncTokenScope, isTelegramWebhookConflict };
