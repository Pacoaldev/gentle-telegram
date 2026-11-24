// Rules under test (S2, S6): the Telegram wire plumbing is pure, so the poll loop, the button
// payload and the allowlist can be checked without a bot token.
import test from "node:test";
import assert from "node:assert/strict";
import {
  apiUrl, getUpdatesBody, decodeUpdate, encodeCallbackData, decodeCallbackData,
  inlineKeyboard, blockerText, orderText, isAllowedChat, chooseChat, safeText, firstAllowedChat,
  telegramFetchFailedInHost, telegramCurlTimeoutSeconds, telegramRefusalDetail,
  POLL_TIMEOUT_MAX, MAX_OPTIONS,
} from "../mods/gentle-telegram/lib/telegram.js";

test("apiUrl: bot method URL, and an empty token is refused", () => {
  assert.equal(apiUrl("123:abc", "getMe"), "https://api.telegram.org/bot123:abc/getMe");
  assert.throws(() => apiUrl("", "getMe"), /token/);
});

test("getUpdatesBody: long poll window is clamped, offset only when known", () => {
  assert.deepEqual(getUpdatesBody({}), { timeout: 25, allowed_updates: ["message", "callback_query"] });
  assert.deepEqual(getUpdatesBody({ offset: 7, timeout: 300 }), {
    offset: 7, timeout: POLL_TIMEOUT_MAX, allowed_updates: ["message", "callback_query"],
  });
  assert.equal(getUpdatesBody({ timeout: -5 }).timeout, 0);
});

test("decodeUpdate: a text message", () => {
  const u = { update_id: 1, message: { message_id: 9, chat: { id: -1001 }, text: " corré los tests " } };
  assert.deepEqual(decodeUpdate(u), { kind: "message", chatId: -1001, messageId: 9, text: "corré los tests", relay: true });
});

test("decodeUpdate: a message without text (or without chat) is not an order", () => {
  assert.equal(decodeUpdate({ update_id: 2, message: { message_id: 1, chat: { id: 5 }, photo: [] } }), null);
  assert.equal(decodeUpdate({ update_id: 2, message: { message_id: 1, text: "hi" } }), null);
  assert.equal(decodeUpdate(null), null);
  assert.equal(decodeUpdate({ update_id: 3 }), null);
});

test("decodeUpdate: a callback query carries the option index and the question it answers", () => {
  const u = { update_id: 4, callback_query: { id: "cb1", data: "gt:2:call_abc", message: { message_id: 44, chat: { id: 7 } } } };
  assert.deepEqual(decodeUpdate(u), {
    kind: "callback", chatId: 7, messageId: 44, callbackId: "cb1", option: 2, toolCallId: "call_abc",
  });
});

test("decodeUpdate: a callback query that is not ours (or is malformed) is ignored", () => {
  assert.equal(decodeUpdate({ update_id: 5, callback_query: { id: "x", data: "noise", message: { message_id: 1, chat: { id: 7 } } } }), null);
  assert.equal(decodeUpdate({ update_id: 6, callback_query: { id: "x", data: "gt:9", message: { message_id: 1, chat: { id: 7 } } } }), null);
  assert.equal(decodeUpdate({ update_id: 7, callback_query: { id: "x", data: "gt:-1:call_a", message: { message_id: 1, chat: { id: 7 } } } }), null);
});

test("callback data round trips, even when the tool call id contains a colon", () => {
  const data = encodeCallbackData(3, "call:a:b");
  assert.equal(data, "gt:3:call:a:b");
  assert.deepEqual(decodeCallbackData(data), { option: 3, toolCallId: "call:a:b" });
  assert.equal(decodeCallbackData("gt:1:"), null);
});

test("inlineKeyboard: one button per option, one column up to four options", () => {
  const rows = inlineKeyboard([{ label: "SI" }, { label: "NO" }], "call_1");
  assert.deepEqual(rows, {
    inline_keyboard: [
      [{ text: "SI", callback_data: "gt:0:call_1" }],
      [{ text: "NO", callback_data: "gt:1:call_1" }],
    ],
  });
});

test("inlineKeyboard: more than four options go two per row", () => {
  const options = Array.from({ length: 5 }, (_, i) => ({ label: `o${i}` }));
  const { inline_keyboard } = inlineKeyboard(options, "call_2");
  assert.deepEqual(inline_keyboard.map((row) => row.length), [2, 2, 1]);
  assert.equal(inline_keyboard[2][0].callback_data, "gt:4:call_2");
});

test("inlineKeyboard: an option without a label still gets one, and the cap holds", () => {
  const { inline_keyboard } = inlineKeyboard([{ label: "" }, { description: "only a description" }], "c");
  assert.equal(inline_keyboard.length, 2);
  assert.equal(inline_keyboard[0][0].text, "Option 1");
  assert.equal(inline_keyboard[1][0].text, "only a description");
  const capped = inlineKeyboard(Array.from({ length: 40 }, () => ({ label: "x" })), "c").inline_keyboard;
  assert.equal(capped.flat().length, MAX_OPTIONS, "a keyboard never carries more buttons than the feed has options");
});

test("isAllowedChat: an empty allowlist allows nothing, a list allows exactly its ids", () => {
  assert.equal(isAllowedChat(7, ""), false);
  assert.equal(isAllowedChat(7, undefined), false);
  assert.equal(isAllowedChat(7, "7"), true);
  assert.equal(isAllowedChat(7, "-1001, 7\n42"), true);
  assert.equal(isAllowedChat(7, "-1001,42"), false);
  assert.equal(isAllowedChat(7, "garbage"), false);
});

test("chooseChat: with no allowlist the first chat that talks becomes the operator's", () => {
  const state = {};
  assert.equal(chooseChat(state, "", 7), true);
  assert.equal(state.chatId, 7);
  assert.equal(chooseChat(state, "", 9), false, "a second chat does not take over");
  assert.equal(chooseChat({ chatId: 7 }, "12", 7), false, "a written allowlist wins over the learned chat");
  assert.equal(chooseChat({ chatId: 7 }, "12", 12), true);
  assert.equal(chooseChat({}, "", "7"), false, "a string chat id is never an operator");
});

test("blockerText: the question, its options and the session, never the word Herdr alone", () => {
  const text = blockerText({
    question: "¿Aplico el cambio?",
    header: "Confirmar",
    sessionId: "s1",
    sessionName: "nox9go",
    cwd: "C:\\proyectos\\nox9go",
    options: [{ label: "SI" }, { label: "NO" }],
  });
  assert.match(text, /¿Aplico el cambio\?/);
  assert.match(text, /1\. SI/);
  assert.match(text, /2\. NO/);
  assert.match(text, /nox9go/);
  assert.deepEqual(blockerText({ question: "", options: [] }), "");
});

test("orderText: an order is echoed with the session it reached", () => {
  assert.equal(orderText("corré los tests", "nox9go"), "→ nox9go: corré los tests");
  assert.equal(orderText("corré", null), "→ Gentle Shell: corré");
});

test("safeText: control characters go, new lines and tabs stay", () => {
  assert.equal(safeText("a\u0000b\u001fc"), "abc");
  assert.equal(safeText("a\nb\tc"), "a\nb\tc");
  assert.equal(safeText(null), "");
});

test("firstAllowedChat: the written allowlist wins, the learned chat is the fallback", () => {
  assert.equal(firstAllowedChat("111, 222", 999), 111);
  assert.equal(firstAllowedChat("", 999), 999);
  assert.equal(firstAllowedChat("   ", null), null);
  assert.equal(firstAllowedChat("not-a-number", 5), 5);
  assert.equal(firstAllowedChat("nope, -1001", 5), -1001, "a group id is negative");
});

test("telegramFetchFailedInHost: reqwest transport errors, not Telegram refusals", () => {
  assert.equal(
    telegramFetchFailedInHost(new Error("fetching https://api.telegram.org/bot1:xx/getMe failed: error sending request for url")),
    true,
  );
  assert.equal(telegramFetchFailedInHost(new Error("Telegram refused getMe: Unauthorized")), false);
  assert.equal(telegramCurlTimeoutSeconds("getUpdates"), 90);
  assert.equal(telegramCurlTimeoutSeconds("getMe"), 60);
});

test("telegramRefusalDetail: 429 names the wait, without echoing the token", () => {
  const msg = telegramRefusalDetail("getMe", {
    ok: false,
    error_code: 429,
    description: "Too Many Requests: retry after 32",
    parameters: { retry_after: 32 },
  }, 429);
  assert.match(msg, /wait 32s/);
});
