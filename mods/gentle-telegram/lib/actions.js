// Desktop actions, as files (S2, S6): the exact bytes this bridge drops in a Gentle Shell session's
// inbox. The shape and the rules mirror Gentle Pi's own validator
// (`lib/desktop-feed-actions.ts`: ACTION_SCHEMA, `argsValid`, DESKTOP_ACTION_LIMITS) and the
// canonical mod writer (`mods/gentle-chat/actions.js`), so a session that accepts its own desktop
// accepts ours. `createdAt` is an ISO string, exactly as that writer sends it.
//
// This module is pure: it builds and validates, and says where the file goes. Writing it and
// waiting for the answer belongs to runtime.js.

import { createHash, randomUUID } from "crypto";

export const ACTION_SCHEMA = "gentle-shell.desktop-action/v1";
export const RESULT_SCHEMA = "gentle-shell.desktop-action-result/v1";
/** The kinds this mod writes. Gentle Pi knows more (`abort_turn`, `cancel_job`, ...). */
export const ACTION_KINDS = ["answer_question", "send_prompt"];
/** Every kind Gentle Pi accepts, so a file naming another one is reported as such, not as junk. */
const KNOWN_KINDS = ["set_permission_mode", "cancel_job", "cancel_subagent", "answer_question", "abort_turn", "send_prompt", "refresh_usage", "apply_profile"];
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_ANSWER = /[\u0000-\u001f\u007f]/;
/** A typed prompt may carry new lines and tabs, never another control character. */
const CONTROL_PROMPT = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const TEXT_MAX = 2000;
const PROMPT_MAX = 4000;
const IDENTIFIER_MAX = 256;

const invalid = (detail = "Invalid desktop action") => ({ ok: false, error: { code: "invalid_action", message: detail } });
const ok = () => ({ ok: true, error: null });
const onlyKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const nonEmpty = (value, max = IDENTIFIER_MAX) => typeof value === "string" && value.length > 0 && value.length <= max;

/** The session's folder name: lib/desktop-feed-store.ts desktopFeedName (safe id, else sha256). */
export function sessionFolder(sessionId) {
  const id = typeof sessionId === "string" ? sessionId : "";
  return SAFE_ID.test(id) ? id : createHash("sha256").update(id).digest("hex");
}

/** An agent dir as a path this module joins: forward slashes, no trailing one. */
export function dirOf(agentDir) {
  return String(agentDir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function inboxPath(agentDir, sessionId) {
  return `${dirOf(agentDir)}/desktop/inbox/${sessionFolder(sessionId)}`;
}

export function outboxPath(agentDir, sessionId, id) {
  return `${dirOf(agentDir)}/desktop/outbox/${sessionFolder(sessionId)}/${id}.json`;
}

function isoNow(now) {
  if (typeof now === "string" && now) return now;
  if (now instanceof Date) return now.toISOString();
  return new Date().toISOString();
}

function action({ sessionId, kind, args, id, now }) {
  return {
    schema: ACTION_SCHEMA,
    id: typeof id === "string" && id ? id : randomUUID(),
    sessionId,
    kind,
    args,
    createdAt: isoNow(now),
  };
}

/** Answer the open question through the session (the path that actually unblocks Pi). */
export function answerAction({ sessionId, toolCallId, option = undefined, text = undefined, id = undefined, now = undefined }) {
  const args = text !== undefined
    ? { toolCallId, via: "session", text }
    : { toolCallId, via: "session", option };
  return action({ sessionId, kind: "answer_question", args, id, now });
}

/** Relay a Telegram order as a prompt inside the session. */
export function promptAction({ sessionId, text, id = undefined, now = undefined }) {
  return action({ sessionId, kind: "send_prompt", args: { text }, id, now });
}

/**
 * The same rules the session applies before it runs a file: a wrong schema, an unknown kind, an
 * extra key, an option that is not an index in 0..63, or a control character is refused here
 * instead of after a round trip.
 */
export function validateAction(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return invalid();
  if (candidate.schema !== ACTION_SCHEMA) return invalid();
  if (!onlyKeys(candidate, ["schema", "id", "sessionId", "kind", "args", "createdAt"])) return invalid();
  if (!nonEmpty(candidate.id) || !nonEmpty(candidate.sessionId) || !nonEmpty(candidate.createdAt)) return invalid();
  if (typeof candidate.kind !== "string") return invalid();
  if (!KNOWN_KINDS.includes(candidate.kind)) return { ok: false, error: { code: "unknown_kind", message: "Unknown desktop action" } };
  const args = candidate.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return invalid();
  if (candidate.kind === "answer_question") {
    if (!onlyKeys(args, ["toolCallId", "option", "text", "via"])) return invalid();
    if (!nonEmpty(args.toolCallId)) return invalid();
    if (args.via !== undefined && args.via !== "session") return invalid();
    const hasOption = args.option !== undefined;
    const hasText = args.text !== undefined;
    if (hasOption === hasText) return invalid("An answer is one option or one text, never both.");
    if (hasOption) {
      if (!Number.isInteger(args.option) || args.option < 0 || args.option > 63) return invalid("An option is an index from 0 to 63.");
      return ok();
    }
    if (!nonEmpty(args.text, TEXT_MAX) || CONTROL_ANSWER.test(args.text)) return invalid("That answer cannot be typed into a session.");
    return ok();
  }
  if (candidate.kind === "send_prompt") {
    if (!onlyKeys(args, ["text"])) return invalid();
    if (!nonEmpty(args.text, PROMPT_MAX) || !args.text.trim()) return invalid();
    if (CONTROL_PROMPT.test(args.text)) return invalid("That prompt cannot be typed into a session.");
    return ok();
  }
  // A kind Gentle Pi knows but this mod does not write: refused, never written half-formed.
  return { ok: false, error: { code: "unsupported_kind", message: `This mod does not write ${candidate.kind}.` } };
}

/** The session's answer to an action file, once it is its own; null while it is not (or not yet). */
export function parseActionResult(text, id) {
  if (typeof text !== "string" || !text.trim()) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || data.schema !== RESULT_SCHEMA || data.id !== id) return null;
  if (data.ok === true) return { ok: true, data: data.data && typeof data.data === "object" ? data.data : {} };
  if (data.ok === false) {
    const error = data.error && typeof data.error === "object" ? data.error : { code: "failed", message: "The session refused this action." };
    return { ok: false, error };
  }
  return null;
}
