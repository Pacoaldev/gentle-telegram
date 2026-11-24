// The poller lock: Telegram allows one long `getUpdates` per bot, and a reloaded or duplicated
// mod view leaves the old loop stranded, so two instances end up fighting over the poll and every
// message is relayed once per instance. The claim is pure: the runtime stores it in `shared` and
// asks this rule who may poll.
import test from "node:test";
import assert from "node:assert/strict";

import { takePollerClaim, POLLER_TTL_MS } from "../mods/gentle-telegram/lib/state.js";

const NOW = 1000;

test("takePollerClaim: an unclaimed poll is taken at once", () => {
  const claim = takePollerClaim(null, "a", NOW);
  assert.deepEqual(claim, { owner: "a", at: NOW });
});

test("takePollerClaim: the owner keeps its claim and refreshes the heartbeat", () => {
  const current = { owner: "a", at: NOW - 1000 };
  const claim = takePollerClaim(current, "a", NOW);
  assert.deepEqual(claim, { owner: "a", at: NOW });
});

test("takePollerClaim: a fresh claim held by another view is denied", () => {
  const current = { owner: "a", at: NOW - POLLER_TTL_MS + 5000 };
  assert.equal(takePollerClaim(current, "b", NOW), null);
});

test("takePollerClaim: a stale claim is taken over", () => {
  const current = { owner: "a", at: NOW - POLLER_TTL_MS - 1 };
  const claim = takePollerClaim(current, "b", NOW);
  assert.deepEqual(claim, { owner: "b", at: NOW });
});

test("takePollerClaim: a malformed claim is not trusted", () => {
  assert.deepEqual(takePollerClaim({}, "a", NOW), { owner: "a", at: NOW });
  assert.deepEqual(takePollerClaim({ owner: "a" }, "b", NOW), { owner: "b", at: NOW });
  assert.deepEqual(takePollerClaim("junk", "a", NOW), { owner: "a", at: NOW });
});

test("takePollerClaim: an owner id that is not a string never polls", () => {
  assert.equal(takePollerClaim(null, 42, NOW), null);
  assert.equal(takePollerClaim(null, null, NOW), null);
});
