// Rules under test (S1, S2): what makes a desktop-feed snapshot a Telegram blocker, and the
// dedup signature NOX9GO settled on (`gentle-feed:<toolCallId>`).
import test from "node:test";
import assert from "node:assert/strict";
import { pendingFrom, feedSignature, pickPending, isBlocked, FEED_SCHEMA } from "../mods/gentle-telegram/lib/feed.js";

const snapshot = (over = {}) => ({
  schema: FEED_SCHEMA,
  identity: { sessionId: "01J-session", sessionName: "nox9go", cwd: "C:\\proyectos\\nox9go", agentDir: "C:\\Users\\me\\.gentle-shell\\agent" },
  activity: { state: "blocked", blockedLabel: "Choice awaiting input" },
  pendingQuestion: {
    kind: "choice", tool: "ask_user_choice", toolCallId: "call_9", question: "¿Sigo?", header: "Plan",
    options: [{ label: "SI", description: "dale" }, { label: "NO" }],
  },
  ...over,
});

test("pendingFrom: a blocked session with an option question becomes a blocker", () => {
  assert.deepEqual(pendingFrom(snapshot()), {
    sessionId: "01J-session", sessionName: "nox9go", cwd: "C:\\proyectos\\nox9go",
    agentDir: "C:\\Users\\me\\.gentle-shell\\agent",
    toolCallId: "call_9", question: "¿Sigo?", header: "Plan", state: "blocked",
    options: [{ label: "SI", description: "dale" }, { label: "NO", description: "" }],
  });
});

test("pendingFrom: 'waiting' counts as blocked, any other state does not", () => {
  assert.equal(pendingFrom(snapshot({ activity: { state: "waiting" } })).state, "waiting");
  assert.equal(pendingFrom(snapshot({ activity: { state: "idle" } })), null);
  assert.equal(pendingFrom(snapshot({ activity: {} })), null);
  assert.equal(isBlocked("blocked"), true);
  assert.equal(isBlocked("working"), false);
});

test("pendingFrom: no question, no blocker", () => {
  assert.equal(pendingFrom(snapshot({ pendingQuestion: null })), null);
  assert.equal(pendingFrom(snapshot({ pendingQuestion: { kind: "choice", question: "¿Sigo?" } })), null);
  assert.equal(pendingFrom(snapshot({ pendingQuestion: { toolCallId: "call_9", options: [{ label: "x" }] } })), null);
});

test("pendingFrom: an option question with no options is not answerable from Telegram", () => {
  assert.equal(pendingFrom(snapshot({ pendingQuestion: { ...snapshot().pendingQuestion, options: [] } })), null);
  assert.equal(pendingFrom(snapshot({ pendingQuestion: { ...snapshot().pendingQuestion, options: [{ description: "no label" }] } })), null);
});

test("pendingFrom: an option list is capped at ten, as the feed is", () => {
  const options = Array.from({ length: 14 }, (_, i) => ({ label: `o${i}` }));
  assert.equal(pendingFrom(snapshot({ pendingQuestion: { ...snapshot().pendingQuestion, options } })).options.length, 10);
});

test("pendingFrom: garbage is not a blocker", () => {
  for (const bad of [null, undefined, 42, "x", [], {}, { schema: "other/v9" }, { identity: {}, activity: { state: "blocked" }, pendingQuestion: {} }]) {
    assert.equal(pendingFrom(bad), null);
  }
});

test("pendingFrom: a session without an agent dir keeps the blocker but cannot be answered", () => {
  const p = pendingFrom(snapshot({ identity: { sessionId: "s", sessionName: "n", cwd: "/tmp" } }));
  assert.equal(p.sessionId, "s");
  assert.equal(p.agentDir, null);
});

test("feedSignature: the tool call id is the identity, so a re-read never re-sends", () => {
  assert.equal(feedSignature(pendingFrom(snapshot())), "gentle-feed:call_9");
});

test("pickPending: the newest snapshot wins, and a snapshot with no blocker is skipped", () => {
  const older = { snapshot: snapshot(), mtimeMs: 100 };
  const newer = { snapshot: snapshot({ identity: { sessionId: "s2" }, pendingQuestion: { ...snapshot().pendingQuestion, toolCallId: "call_2" } }), mtimeMs: 200 };
  const idle = { snapshot: snapshot({ activity: { state: "idle" } }), mtimeMs: 300 };
  assert.equal(pickPending([older, newer, idle]).toolCallId, "call_2");
  assert.equal(pickPending([idle, null, undefined, { snapshot: "x", mtimeMs: 5 }]), null);
  assert.equal(pickPending([]), null);
});
