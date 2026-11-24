// Telegram Bridge: a phone in the loop of a Gentle Shell.
//
// What it does (S1, S2): every few seconds it reads the desktop feed of the Gentle Shell sessions
// on this machine (`<agentDir>/desktop/sessions/*.json`); when one is blocked on an option
// question it sends that question to the allowed Telegram chat with one button per option; a tap
// answers through the session's own inbox (`answer_question`, `via: session`), which is the path
// that actually unblocks Pi. A message you send from Telegram is relayed into the newest session
// as a `send_prompt` desktop action, or typed into the focused terminal when that session takes no
// desktop actions.
//
// The rules live in ./lib (unit-tested, no host imports); ./runtime.js is the wiring; this file is
// the view and the loops. Host discipline: every `shared`/`focused` read happens synchronously at
// the head of a host call, and every answer from the network or the filesystem is turned into UI
// inside `cx.timer.after`.
import { View, div } from "gpui-kit";
import { TextareaState } from "gpui-base";
import { nextCommand, shared, setShared } from "herdr";
import * as rt from "./runtime.js";
import { decodeUpdate, blockerText, inlineKeyboard, firstAllowedChat } from "./lib/telegram.js";
import { feedSignature } from "./lib/feed.js";
import { counters } from "./lib/state.js";
import { palette } from "./tokens.js";
import { screen } from "./ui.js";

const MOD = "gentle-telegram";
const SCAN_MS = 4000; // how often the feed is read for a new question
const IDLE_MS = 1500; // the loop's sleep when there is nothing to poll
const ERROR_MS = 5000; // after a failed poll: what a retry costs
const WATCH_RETRY_MS = 5000; // after a folder watch failed (the folder may not exist yet)
const ERROR_REPEAT_MS = 60000; // the same complaint is not logged again within this window
const LEARNED_NOTE = "No allowlist yet: this chat is now the operator's. Write its id in the mod's settings to make it permanent.";

/**
 * False once this build of the mod was reloaded or closed: Herdr ends an old build's async loops at
 * its next `cx` use, so a loop that only awaits host calls checks this after every wait instead of
 * running on with code nobody shows (the shape filer-pro uses).
 */
function live(cx) {
  try {
    cx.phase();
    return true;
  } catch {
    return false;
  }
}

/** The mods-hub can turn a mod off (shared "herdr-mods.disabled", a list of mod names). */
const kitOff = () => {
  try {
    const off = shared("herdr-mods.disabled");
    return Array.isArray(off) && off.includes(MOD);
  } catch {
    return false;
  }
};

export default class GentleTelegram extends View {
  init(_props, cx) {
    this.state = rt.loadState();
    this.settings = { token: null, allowlist: "", poll: true, orders: true, details: true };
    this.pending = null;
    this.counters = counters(this.state);
    this.error = null;
    this.errorAt = 0;
    this.status = "idle";
    this.busy = false;
    this.nextScan = 0;
    this.recency = rt.createRecency();
    this.pollerId = `view-${Math.random().toString(36).slice(2, 10)}`;
    this.input = TextareaState.new({ placeholder: "Order for the shown Gentle Shell…", rows: 1 });
    this.sync();
    cx.spawn((cx) => this.pollLoop(cx));
    cx.spawn((cx) => this.commandLoop(cx));
    cx.spawn((cx) => this.watchLoop(cx));
  }

  /** Herdr's own reads: only ever called from inside a host call. */
  sync() {
    try {
      const settings = rt.settings();
      this.settings.token = settings.token;
      this.settings.allowlist = settings.allowlist;
      this.settings.poll = settings.poll;
      this.settings.orders = settings.orders;
      this.settings.details = settings.details;
    } catch (error) {
      this.warn(`Reading the mod's settings failed: ${rt.errorText(error)}`);
    }
    this.counters = counters(this.state);
  }

  // --- the loops -------------------------------------------------------------------------------

  /**
   * The poll: a long `getUpdates` (25 s) followed by a feed read every SCAN_MS. While polling is
   * off it only sleeps, so the mod costs nothing until it is given a token.
   */
  async pollLoop(cx) {
    for (;;) {
      if (!live(cx)) return;
      if (kitOff()) {
        await cx.sleep(IDLE_MS);
        continue;
      }
      this.sync();
      if (!this.settings.poll || !this.settings.token) {
        await cx.sleep(IDLE_MS);
        continue;
      }
      // One bot, one long poll: without the claim this view only sleeps (its claim or another
      // view's is doing the work; a stranded loop's claim expires and is taken over).
      if (!rt.claimPoller(this.pollerId)) {
        this.status = "idle";
        await cx.sleep(IDLE_MS);
        continue;
      }
      try {
        const updates = await rt.getUpdates(this.settings.token, this.state.offset);
        this.status = "polling";
        // A failed cycle must not outlive its cause: clear the stale banner once the poll answers.
        if (this.error) {
          this.error = null;
          this.errorAt = 0;
        }
        if (updates.length) cx.timer.after(1, (cx) => this.consume(updates, cx));
        else cx.timer.after(1, (cx) => cx.notify());
      } catch (error) {
        const message = rt.errorText(error);
        cx.timer.after(1, (cx) => {
          this.status = "error";
          this.warn(message);
          cx.notify();
        });
        await cx.sleep(ERROR_MS);
        continue;
      }
      if (Date.now() < this.nextScan) continue;
      this.nextScan = Date.now() + SCAN_MS;
      try {
        const entries = await rt.scanFeed(rt.agentDirs(), this.recency);
        cx.timer.after(1, (cx) => this.announce(entries, cx));
      } catch (error) {
        const message = `Reading the Gentle Shell feed failed: ${rt.errorText(error)}`;
        cx.timer.after(1, (cx) => {
          this.warn(message);
          cx.notify();
        });
      }
    }
  }

  /**
   * A folder watch per session folder: a mod cannot ask a file for its time, so the changes the
   * watch reports are what make "the newest session" knowable (see runtime.scanFeed).
   */
  async watchLoop(cx) {
    for (const agentDir of rt.agentDirs()) {
      cx.spawn(async (cx) => {
        const folder = rt.sessionsFolder(agentDir);
        for (;;) {
          if (!live(cx)) return;
          try {
            rt.markChanged(this.recency, await rt.watchFolder(folder));
          } catch {
            await cx.sleep(WATCH_RETRY_MS);
          }
        }
      });
    }
  }

  /** Key commands (kit.json actions, or `alt-s` in keys.json as "gentle-telegram:<command>"). */
  async commandLoop(cx) {
    for (;;) {
      const raw = await nextCommand();
      if (!live(cx)) return;
      cx.timer.after(1, (cx) => this.command(raw, cx));
    }
  }

  command(raw, cx) {
    const name = String(raw ?? "").split(":").pop();
    if (name === "start") this.togglePoll(cx, true);
    else if (name === "stop") this.togglePoll(cx, false);
    else if (name === "check") this.check(cx);
    else if (name === "send") this.send(cx);
    else if (name === "forget-chat") this.forgetChat(cx);
    else if (/^answer-\d+$/.test(name)) this.answer(cx, Number(name.slice("answer-".length)));
  }

  // --- Telegram in -----------------------------------------------------------------------------

  /**
   * One batch of updates. The two host reads happen before the first await, and the offset is
   * advanced whether or not each update could be handled, so nothing is fetched twice (S7).
   */
  async consume(updates, cx) {
    const settings = { ...this.settings };
    const address = rt.focusedAddress();
    for (const raw of updates) {
      const update = decodeUpdate(raw);
      if (!update) continue;
      const admission = rt.admit(this.state, settings.allowlist, update.chatId);
      if (admission.learned) this.warn(LEARNED_NOTE);
      if (!admission.allowed) continue;
      if (update.kind === "callback") await this.takeAnswer(update, cx);
      else if (update.relay && settings.orders) await this.relay(update.text, address, cx, update.chatId);
    }
    rt.advanceOffset(this.state, updates);
    rt.saveState(this.state);
    cx.timer.after(1, (cx) => {
      this.counters = counters(this.state);
      cx.notify();
    });
  }

  /** A tapped button: answer the question it was sent for, through the session (S2). */
  async takeAnswer(update, cx) {
    const token = this.settings.token;
    const bridge = rt.bridgeFor(this.state, update.toolCallId);
    const target = bridge?.agentDir
      ? { sessionId: bridge.sessionId, agentDir: bridge.agentDir, toolCallId: update.toolCallId }
      : this.pending?.agentDir && this.pending.toolCallId === update.toolCallId
        ? { sessionId: this.pending.sessionId, agentDir: this.pending.agentDir, toolCallId: update.toolCallId }
        : null;
    if (!target) {
      await this.tell(token, "answerCallback", update, "That question is no longer open.");
      this.warn("A button was tapped for a question that is no longer open.");
      return;
    }
    const label = this.pending?.options?.[update.option]?.label ?? `option ${update.option + 1}`;
    this.busy = true;
    const result = await rt.answerQuestion({ target, option: update.option, sleep: (ms) => cx.sleep(ms) });
    this.busy = false;
    if (!result.ok) {
      this.warn(`The session refused the answer: ${result.error?.message ?? "no result"}`);
      await this.tell(token, "answerCallback", update, result.error?.message ?? "The session did not answer.");
      return;
    }
    rt.logEvent(this.state, "answered", label);
    rt.saveState(this.state);
    await this.tell(token, "answerCallback", update, `Sent: ${label}`);
    const message = bridge ?? null;
    if (message && Number.isInteger(message.messageId)) {
      await rt
        .editMessage(token, message.chatId, message.messageId, `${blockerText({ ...this.pending, options: this.pending?.options ?? [] })}\n\n✅ ${label}`)
        .catch(() => null);
    }
    cx.timer.after(1, (cx) => {
      this.counters = counters(this.state);
      cx.notify();
    });
  }

  /** A typed order: `send_prompt` into the newest session, else the focused terminal. */
  async relay(text, address, cx, chatId) {
    const token = this.settings.token;
    const pending = this.pending?.agentDir ? { sessionId: this.pending.sessionId, agentDir: this.pending.agentDir } : null;
    let target = pending;
    try {
      target = rt.orderTargetOf(await rt.scanFeed(rt.agentDirs(), this.recency)) ?? pending;
    } catch {
      target = pending;
    }
    const sent = await rt.sendOrder({ target, fallbackAddress: address, text, sleep: (ms) => cx.sleep(ms) });
    const where = sent.ok ? (sent.via === "session" ? target?.sessionId ?? "the session" : "the focused terminal") : null;
    if (sent.ok) rt.logEvent(this.state, "order", text);
    else this.warn(`The order did not go out: ${sent.error?.message ?? "no target"}`);
    rt.saveState(this.state);
    if (token && Number.isInteger(chatId)) {
      const reply = sent.ok ? `→ ${where}: ${text}` : `Not sent: ${sent.error?.message ?? "no target"}`;
      await rt.sendMessage(token, chatId, reply).catch(() => null);
    }
    cx.timer.after(1, (cx) => {
      this.counters = counters(this.state);
      cx.notify();
    });
  }

  async tell(token, method, update, text) {
    if (!token || method !== "answerCallback") return;
    await rt.answerCallback(token, update.callbackId, text).catch(() => null);
  }

  /** A question the machine now waits on: tell the allowed chat, once (S7). */
  announce(entries, cx) {
    this.pending = rt.pendingOf(entries);
    if (!this.pending || !this.settings.token) {
      cx.notify();
      return;
    }
    const signature = feedSignature(this.pending);
    if (this.state.seen.includes(signature)) {
      cx.notify();
      return;
    }
    // Seen before the send: a Telegram failure must not turn into the same question every 4 s.
    rt.noteSeen(this.state, signature);
    rt.saveState(this.state);
    cx.notify();
    const chatId = firstAllowedChat(this.settings.allowlist, this.state.chatId);
    if (!chatId) {
      this.warn("A question is open, but no Telegram chat may be told yet: write the bot once, or set the allowlist.");
      return;
    }
    const pending = this.pending;
    const keyboard = inlineKeyboard(pending.options, pending.toolCallId);
    rt.sendMessage(this.settings.token, chatId, blockerText(pending), keyboard)
      .then((message) => {
        rt.rememberBridge(this.state, {
          toolCallId: pending.toolCallId,
          sessionId: pending.sessionId,
          agentDir: pending.agentDir,
          chatId,
          messageId: message?.message_id,
        });
        rt.logEvent(this.state, "blocker", pending.question, { signature });
        rt.saveState(this.state);
        cx.timer.after(1, (cx) => {
          this.counters = counters(this.state);
          cx.notify();
        });
      })
      .catch((error) => {
        const message = rt.errorText(error);
        cx.timer.after(1, (cx) => {
          this.warn(`Telegram refused the question: ${message}`);
          cx.notify();
        });
      });
  }

  // --- the person ------------------------------------------------------------------------------

  togglePoll(cx, on) {
    const next = on === undefined ? !this.settings.poll : on;
    this.settings.poll = next;
    setShared(rt.SETTING.poll, next);
    if (!next) this.status = "idle";
    cx.notify();
  }

  async check(cx) {
    const token = this.settings.token;
    if (!token) return;
    this.status = "checking";
    cx.notify();
    try {
      const me = await rt.getMe(token);
      this.status = "polling";
      rt.logEvent(this.state, "notice", `Token is good: @${me.username ?? me.id ?? "bot"}`);
      this.error = null;
    } catch (error) {
      this.status = "error";
      this.warn(rt.errorText(error));
    }
    rt.saveState(this.state);
    cx.timer.after(1, (cx) => {
      this.counters = counters(this.state);
      cx.notify();
    });
  }

  forgetChat(cx) {
    this.state.chatId = null;
    rt.saveState(this.state);
    this.warn("The learned chat is forgotten: the next chat that writes becomes the operator's.");
    cx.notify();
  }

  send(cx) {
    const text = this.input.value();
    if (!String(text ?? "").trim()) return;
    this.input.set_value("");
    this.relay(text, rt.focusedAddress(), cx, firstAllowedChat(this.settings.allowlist, this.state.chatId));
  }

  answer(cx, option) {
    const pending = this.pending;
    if (!pending?.agentDir || this.busy) return;
    const bridge = rt.bridgeFor(this.state, pending.toolCallId);
    const target = { sessionId: pending.sessionId, agentDir: pending.agentDir, toolCallId: pending.toolCallId };
    this.busy = true;
    cx.notify();
    rt.answerQuestion({ target, option, sleep: (ms) => cx.sleep(ms) }).then((result) => {
      this.busy = false;
      const label = pending.options[option]?.label ?? `option ${option + 1}`;
      if (result.ok) {
        rt.logEvent(this.state, "answered", label);
        if (bridge?.agentDir) {
          rt.editMessage(this.settings.token, bridge.chatId, bridge.messageId, `✅ ${label}`).catch(() => null);
        }
      } else {
        this.warn(`The session refused the answer: ${result.error?.message ?? "no result"}`);
      }
      rt.saveState(this.state);
      cx.timer.after(1, (cx) => {
        this.counters = counters(this.state);
        cx.notify();
      });
    });
  }

  /** The newest complaint, and the same one at most once a minute (S7: no noise in the log). */
  warn(message) {
    const text = String(message ?? "").trim();
    if (!text) return;
    const now = Date.now();
    if (this.error === text && now - this.errorAt < ERROR_REPEAT_MS) return;
    this.error = text;
    this.errorAt = now;
    rt.logEvent(this.state, "error", text);
  }

  render(cx) {
    if (kitOff()) return div();
    return screen(palette(), this, cx);
  }
}
