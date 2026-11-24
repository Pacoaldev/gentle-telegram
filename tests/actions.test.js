// Rules under test (S2, S6): the file we drop in a Gentle Shell inbox is the answer path that
// unblocks Pi, so its shape is pinned here, not at runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import {
  answerAction, promptAction, validateAction, sessionFolder, inboxPath, outboxPath,
  parseActionResult, ACTION_SCHEMA, RESULT_SCHEMA,
} from "../mods/gentle-telegram/lib/actions.js";

const AGENT_DIR = "C:\\Users\\me\\.gentle-shell\\agent";

test("sessionFolder: a safe id is the folder name, anything else is its sha256", () => {
  assert.equal(sessionFolder("01J-abc_DEF"), "01J-abc_DEF");
  const odd = "a:b/c d";
  assert.equal(sessionFolder(odd), createHash("sha256").update(odd).digest("hex"));
  assert.equal(sessionFolder(""), createHash("sha256").update("").digest("hex"));
});

test("inboxPath / outboxPath: both under the session's own agent dir", () => {
  assert.equal(inboxPath(AGENT_DIR, "01J"), "C:/Users/me/.gentle-shell/agent/desktop/inbox/01J");
  assert.equal(inboxPath(`${AGENT_DIR}\\`, "01J"), "C:/Users/me/.gentle-shell/agent/desktop/inbox/01J");
  assert.equal(outboxPath(AGENT_DIR, "01J", "id-1"), "C:/Users/me/.gentle-shell/agent/desktop/outbox/01J/id-1.json");
  assert.equal(inboxPath(AGENT_DIR, "schedule/x"), `C:/Users/me/.gentle-shell/agent/desktop/inbox/${createHash("sha256").update("schedule/x").digest("hex")}`);
});

test("answerAction: the exact file Gentle Shell expects, answered through the session", () => {
  const action = answerAction({ sessionId: "01J", toolCallId: "call_9", option: 2, id: "id-1", now: "2026-11-24T10:00:00.000Z" });
  assert.deepEqual(action, {
    schema: ACTION_SCHEMA,
    id: "id-1",
    sessionId: "01J",
    kind: "answer_question",
    args: { toolCallId: "call_9", option: 2, via: "session" },
    createdAt: "2026-11-24T10:00:00.000Z",
  });
  assert.equal(validateAction(action).ok, true);
});

test("promptAction: a Telegram order runs as a typed prompt in the session", () => {
  const action = promptAction({ sessionId: "01J", text: "corré los tests", id: "id-2", now: "2026-11-24T10:00:00.000Z" });
  assert.equal(action.kind, "send_prompt");
  assert.deepEqual(action.args, { text: "corré los tests" });
  assert.equal(validateAction(action).ok, true);
});

test("validateAction: the schema, the kind and the key set are enforced", () => {
  const good = answerAction({ sessionId: "01J", toolCallId: "c", option: 0, id: "i", now: "2026-11-24T10:00:00.000Z" });
  assert.equal(validateAction({ ...good, schema: "other/v1" }).error.code, "invalid_action");
  assert.equal(validateAction({ ...good, kind: "run_shell" }).error.code, "unknown_kind");
  assert.equal(validateAction({ ...good, args: { ...good.args, extra: 1 } }).error.code, "invalid_action");
  assert.equal(validateAction({ ...good, sessionId: undefined }).ok, false);
  assert.equal(validateAction(null).ok, false);
});

test("validateAction: an option is an index in range, never a label or a wild number", () => {
  const build = (option) => answerAction({ sessionId: "s", toolCallId: "c", option, id: "i", now: "2026-11-24T10:00:00.000Z" });
  assert.equal(validateAction(build(63)).ok, true);
  assert.equal(validateAction(build(64)).ok, false);
  assert.equal(validateAction(build(-1)).ok, false);
  assert.equal(validateAction(build(1.5)).ok, false);
  assert.equal(validateAction(build("SI")).ok, false);
});

test("validateAction: a typed answer is either an option or text, never both and never neither", () => {
  const base = { schema: ACTION_SCHEMA, id: "i", sessionId: "s", kind: "answer_question", createdAt: "2026-11-24T10:00:00.000Z" };
  const args = (a) => validateAction({ ...base, args: a });
  assert.equal(args({ toolCallId: "c", text: "sí, dale", via: "session" }).ok, true);
  assert.equal(args({ toolCallId: "c", option: 1, text: "sí" }).ok, false);
  assert.equal(args({ toolCallId: "c", via: "session" }).ok, false);
  assert.equal(args({ toolCallId: "c", option: 1, via: "terminal" }).ok, false);
  assert.equal(args({ toolCallId: "c", option: 1, text: "" }).ok, false);
  assert.equal(args({ toolCallId: "", option: 1 }).ok, false);
});

test("validateAction: control characters never travel, and the limits hold", () => {
  const withText = (text) => validateAction({ schema: ACTION_SCHEMA, id: "i", sessionId: "s", kind: "answer_question", createdAt: "2026-11-24T10:00:00.000Z", args: { toolCallId: "c", text } });
  assert.equal(withText("ok\u0007").ok, false);
  assert.equal(withText("a".repeat(2001)).ok, false);
  assert.equal(withText("a".repeat(2000)).ok, true);
  const prompt = (text) => promptAction({ sessionId: "s", text, id: "i", now: "2026-11-24T10:00:00.000Z" });
  assert.equal(validateAction(prompt("linea 1\nlinea 2\tfin")).ok, true);
  assert.equal(validateAction({ ...prompt("ok"), args: { text: "   " } }).ok, false);
  assert.equal(validateAction(prompt("a".repeat(4001))).ok, false);
});

test("parseActionResult: the session's answer, only when it is its own", () => {
  const ok = JSON.stringify({ schema: RESULT_SCHEMA, id: "id-1", ok: true, data: { answered: true } });
  assert.deepEqual(parseActionResult(ok, "id-1"), { ok: true, data: { answered: true } });
  const no = JSON.stringify({ schema: RESULT_SCHEMA, id: "id-1", ok: false, error: { code: "stale", message: "too old" } });
  assert.deepEqual(parseActionResult(no, "id-1"), { ok: false, error: { code: "stale", message: "too old" } });
  assert.equal(parseActionResult(ok, "other"), null);
  assert.equal(parseActionResult("{ half", "id-1"), null);
  assert.equal(parseActionResult(JSON.stringify({ schema: "other", id: "id-1", ok: true }), "id-1"), null);
});
