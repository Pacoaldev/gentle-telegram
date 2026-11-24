// What the bridge remembers (S2, S7): the Telegram offset, the blockers it already sent, a bounded
// log for the view and the counters it shows. Plain JSON, so it can live in `shared` and survive a
// mod reload — and pure, so the bounds are testable instead of hoped for.

export const SEEN_MAX = 256;
export const EVENTS_MAX = 100;

/** How long a poller claim stays valid without a heartbeat. One long poll is 25 s. */
export const POLLER_TTL_MS = 45000;

const COUNTER_BY_KIND = { blocker: "seen", answered: "answered", order: "orders", error: "errors" };

export function createState() {
  return {
    offset: /** @type {number | null} */ (null),
    tokenKey: /** @type {string | null} */ (null),
    chatId: /** @type {number | null} */ (null),
    rateLimitUntil: /** @type {number | null} */ (null),
    bridges: /** @type {any[]} */ ([]),
    seen: /** @type {string[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    counters: { seen: 0, answered: 0, orders: 0, errors: 0 },
  };
}

/** A compact non-secret fingerprint of a bot token (its numeric bot id, or its head+tail). */
export function tokenFingerprint(token) {
  const t = typeof token === "string" ? token.trim() : "";
  if (!t) return null;
  const colon = t.indexOf(":");
  if (colon > 0) return `${t.slice(0, colon)}:${t.slice(-4)}`;
  return t.slice(0, 8);
}

/**
 * When the configured bot token changes, reset the previous bot's offset and rate-limit cooldown
 * so a new bot never inherits a stale 429 lockout or an incompatible update_id offset.
 */
export function syncTokenScope(state, token) {
  if (!state || typeof state !== "object") return false;
  const next = tokenFingerprint(token);
  if (!next || state.tokenKey === next) return false;
  const changed = state.tokenKey !== null && state.tokenKey !== undefined;
  state.tokenKey = next;
  if (changed) {
    state.offset = null;
    state.rateLimitUntil = null;
    state.chatId = null;
    if (Array.isArray(state.bridges)) state.bridges = [];
  }
  return changed;
}

/** True the first time a signature is seen; false every time after, until the memory evicts it. */
export function noteSeen(state, signature) {
  const sig = typeof signature === "string" ? signature : "";
  if (!sig) return false;
  if (state.seen.includes(sig)) return false;
  state.seen.push(sig);
  if (state.seen.length > SEEN_MAX) state.seen.splice(0, state.seen.length - SEEN_MAX);
  return true;
}

/** Newest first, bounded, and counted by kind for the header. */
export function pushEvent(state, event) {
  const ev = { at: new Date().toISOString(), ...event };
  state.events.unshift(ev);
  if (state.events.length > EVENTS_MAX) state.events.length = EVENTS_MAX;
  const kind = ev && typeof ev === "object" ? ev.kind : null;
  const counter = kind && kind in COUNTER_BY_KIND ? COUNTER_BY_KIND[/** @type {keyof typeof COUNTER_BY_KIND} */ (kind)] : null;
  if (counter) state.counters[counter] += 1;
  return ev;
}

/** The offset of the next update, so Telegram never hands the same one twice. */
export function advanceOffset(state, updates) {
  const ids = (Array.isArray(updates) ? updates : [])
    .map((update) => (Number.isInteger(update?.update_id) ? update.update_id : null))
    .filter((id) => id !== null);
  if (!ids.length) return state.offset;
  const next = Math.max(...ids) + 1;
  if (state.offset === null || next > state.offset) state.offset = next;
  return state.offset;
}

export function counters(state) {
  return { ...createState().counters, ...state?.counters };
}

/**
 * Who may run the one `getUpdates` long poll Telegram allows: the holder of the claim, refreshed
 * every cycle, or whoever takes it over once the heartbeat goes quiet (a stranded loop from a
 * reloaded view never releases cleanly, so the TTL is the release). Returns the new claim, or null
 * when another live view owns the poll. Pure: the runtime stores the claim in `shared`.
 */
export function takePollerClaim(current, ownerId, now, ttlMs = POLLER_TTL_MS) {
  const owner = typeof ownerId === "string" && ownerId ? ownerId : null;
  if (!owner) return null;
  const held = current && typeof current === "object" ? current : null;
  const mine = held?.owner === owner;
  const at = Number.isFinite(held?.at) ? held.at : -Infinity;
  const stale = now - at > ttlMs;
  if (!mine && !stale) return null;
  return { owner, at: now };
}
