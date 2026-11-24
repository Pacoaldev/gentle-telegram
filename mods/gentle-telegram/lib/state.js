// What the bridge remembers (S2, S7): the Telegram offset, the blockers it already sent, a bounded
// log for the view and the counters it shows. Plain JSON, so it can live in `shared` and survive a
// mod reload — and pure, so the bounds are testable instead of hoped for.

export const SEEN_MAX = 256;
export const EVENTS_MAX = 100;

const COUNTER_BY_KIND = { blocker: "seen", answered: "answered", order: "orders", error: "errors" };

export function createState() {
  return { offset: null, seen: [], events: [], counters: { seen: 0, answered: 0, orders: 0, errors: 0 } };
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
  const counter = COUNTER_BY_KIND[ev.kind];
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
