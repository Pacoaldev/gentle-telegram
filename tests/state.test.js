// Rules under test (S2, S7): the bridge remembers what it already sent, keeps a bounded log and
// never re-sends an update, and that state is plain data so it can also live in `shared`.
import test from "node:test";
import assert from "node:assert/strict";
import { createState, noteSeen, pushEvent, advanceOffset, counters, EVENTS_MAX, SEEN_MAX } from "../mods/gentle-telegram/lib/state.js";

test("createState: an empty bridge with no offset", () => {
  const s = createState();
  assert.equal(s.offset, null);
  assert.deepEqual(s.events, []);
  assert.deepEqual(s.seen, []);
  assert.deepEqual(counters(s), { seen: 0, answered: 0, orders: 0, errors: 0 });
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
