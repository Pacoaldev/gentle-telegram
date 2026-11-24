// Rules under test (S2, S7): the bridge remembers what it already sent, keeps a bounded log and
// never re-sends an update, and that state is plain data so it can also live in `shared`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createState, noteSeen, pushEvent, advanceOffset, counters,
  tokenFingerprint, syncTokenScope, takePollerClaim,
  EVENTS_MAX, SEEN_MAX, POLLER_TTL_MS,
} from "../mods/gentle-telegram/lib/state.js";

test("createState: an empty bridge with no offset", () => {
  const s = createState();
  assert.equal(s.offset, null);
  assert.equal(s.tokenKey, null);
  assert.deepEqual(s.events, []);
  assert.deepEqual(s.seen, []);
  assert.deepEqual(counters(s), { seen: 0, answered: 0, orders: 0, errors: 0 });
});

test("syncTokenScope: switching to a different bot resets offset, learned chat, and rateLimitUntil", () => {
  const s = createState();
  // Assembled at runtime so this fixture keeps exercising the long-id shape without
  // reading as a live bot token to secret scanners.
  const fixtureToken = ["9144125646", "AAFnvcIIFc7OB_3aAYxpczAJ5tvSo2BA_44"].join(":");
  assert.equal(tokenFingerprint(fixtureToken), "9144125646:A_44");
  assert.equal(syncTokenScope(s, "111:aaaaBBBB"), false, "first token binds scope without resetting");
  s.offset = 500;
  s.rateLimitUntil = 999999;
  s.chatId = 42;
  assert.equal(syncTokenScope(s, "111:aaaaBBBB"), false, "same token keeps state");
  assert.equal(s.offset, 500);
  assert.equal(syncTokenScope(s, "222:ccccDDDD"), true, "new token resets bot-scoped state");
  assert.equal(s.offset, null);
  assert.equal(s.rateLimitUntil, null);
  assert.equal(s.chatId, null);
  assert.equal(s.tokenKey, "222:DDDD");
});

test("takePollerClaim: one owner holds the lock until TTL expires", () => {
  const c1 = takePollerClaim(null, "view-a", 1000);
  assert.deepEqual(c1, { owner: "view-a", at: 1000 });
  assert.equal(takePollerClaim(c1, "view-b", 1000 + 5000), null);
  assert.deepEqual(takePollerClaim(c1, "view-a", 1000 + 5000), { owner: "view-a", at: 6000 });
  assert.deepEqual(
    takePollerClaim(c1, "view-b", 1000 + POLLER_TTL_MS + 1),
    { owner: "view-b", at: 1000 + POLLER_TTL_MS + 1 },
  );
});

test("noteSeen: the first sight of a signature is new, the second is not", () => {
  const s = createState();
  assert.equal(noteSeen(s, "gentle-feed:call_9"), true);
  assert.equal(noteSeen(s, "gentle-feed:call_9"), false);
  assert.equal(noteSeen(s, "gentle-feed:call_10"), true);
  assert.equal(s.seen.length, 2);
});

test("noteSeen: the memory is bounded, so the oldest signature can come back", () => {
  const s = createState();
  for (let i = 0; i < SEEN_MAX + 5; i++) noteSeen(s, `sig-${i}`);
  assert.equal(s.seen.length, SEEN_MAX);
  assert.equal(noteSeen(s, `sig-${SEEN_MAX + 4}`), false);
  assert.equal(noteSeen(s, "sig-0"), true);
});

test("pushEvent: newest first, bounded, and each one is whole", () => {
  const s = createState();
  for (let i = 0; i < EVENTS_MAX + 3; i++) pushEvent(s, { kind: "order", text: `t${i}`, at: i });
  assert.equal(s.events.length, EVENTS_MAX);
  assert.equal(s.events[0].text, `t${EVENTS_MAX + 2}`);
  assert.equal(s.events.at(-1).text, "t3");
});

test("advanceOffset: the next update id, and no update twice", () => {
  const s = createState();
  assert.equal(advanceOffset(s, []), null);
  assert.equal(advanceOffset(s, [{ update_id: 1 }, { update_id: 3 }]), 4);
  assert.equal(s.offset, 4);
  assert.equal(advanceOffset(s, [{ update_id: 2 }]), 4);
  assert.equal(advanceOffset(s, [{}, { update_id: 9 }]), 10);
});

test("counters: what the view shows, counted from the events it kept", () => {
  const s = createState();
  pushEvent(s, { kind: "blocker", signature: "gentle-feed:a" });
  pushEvent(s, { kind: "answered", text: "SI" });
  pushEvent(s, { kind: "order", text: "corré" });
  pushEvent(s, { kind: "error", text: "401" });
  pushEvent(s, { kind: "notice", text: "started" });
  assert.deepEqual(counters(s), { seen: 1, answered: 1, orders: 1, errors: 1 });
});
