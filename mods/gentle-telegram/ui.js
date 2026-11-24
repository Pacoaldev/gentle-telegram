// The window: the bridge's state, drawn. `v` is the view (main.js), `p` the palette (tokens.js).
// Nothing here reads or writes the bridge: it draws what the view already decided.
import { div } from "gpui-kit";
import { v_flex, h_flex, Textarea } from "gpui-base";

const CLEAR = "#00000000";
const LOG_ROWS = 14;

export function chip(p, text, color) {
  return div().flex_none().px(6).py(1).rounded(p.R.chip).bg(p.raised).text_size(11).text_color(color ?? p.muted).child(text);
}

export function button(p, label, on, opts = {}) {
  return div()
    .flex_none().px(10).py(4).rounded(p.R.chip).border(1).border_color(opts.primary ? p.accent : p.lineStrong)
    .bg(opts.primary ? p.accent : p.raised)
    .text_color(opts.primary ? p.background : p.text)
    .text_size(12).cursor_pointer()
    .when(Boolean(opts.disabled), (el) => el.opacity(0.45))
    .hover((st) => st.bg(opts.primary ? p.accent : p.hover))
    .on_click(on)
    .child(label);
}

export function notice(p, text, color, bg) {
  return div().w_full().flex_none().px(10).py(6).rounded(p.R.row).bg(bg ?? p.raised).border(1).border_color(p.line)
    .text_size(12).text_color(color ?? p.muted).child(text);
}

const STATUS = { polling: ["polling", "ok"], idle: ["idle", "muted"], error: ["error", "err"], checking: ["checking", "info"] };

function statusChip(p, v) {
  const [label, role] = STATUS[v.status] ?? STATUS.idle;
  return chip(p, v.busy ? "working" : label, p[role]);
}

const clock = (at) => String(at ?? "").slice(11, 19);
const KIND_COLOR = { blocker: "warn", answered: "ok", order: "info", error: "err", notice: "muted" };

function header(p, v, cx) {
  const c = v.counters ?? { seen: 0, answered: 0, orders: 0, errors: 0 };
  return v_flex().w_full().flex_none().px(14).pt(12).pb(8).gap(6)
    .child(h_flex().w_full().gap(6).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child("Telegram Bridge"))
      .child(statusChip(p, v))
      .child(chip(p, `${c.seen} seen`, p.muted))
      .child(chip(p, `${c.answered} answered`, p.ok))
      .child(chip(p, `${c.orders} orders`, p.info))
      .when(c.errors > 0, (el) => el.child(chip(p, `${c.errors} errors`, p.err))))
    .when(Boolean(v.error), (el) => el.child(notice(p, v.error, p.err)))
    .when(!v.settings.token, (el) => el.child(notice(
      p,
      "No bot token yet. Paste the token @BotFather gave you in this mod's settings, then start polling.",
      p.warn,
    )))
    .when(Boolean(v.settings.token) && !v.settings.poll, (el) => el.child(notice(p, "Polling is off: nothing is sent to Telegram and no order is relayed.", p.muted)))
    .child(h_flex().w_full().gap(6).items_center()
      .child(button(p, v.settings.poll ? "Stop polling" : "Start polling", (_e, cx) => v.togglePoll(cx), { primary: !v.settings.poll }))
      .child(button(p, "Check token", (_e, cx) => v.check(cx), { disabled: !v.settings.token || v.busy }))
      .child(button(p, "Forget the learned chat", (_e, cx) => v.forgetChat(cx), { disabled: !v.state.chatId })));
}

function blockerCard(p, v, cx) {
  const q = v.pending;
  if (!q) return null;
  return v_flex().w_full().flex_none().gap(6).px(10).py(8).rounded(p.R.card).bg(p.raised).border(1).border_color(p.warn)
    .child(h_flex().w_full().gap(6).items_center()
      .child(chip(p, "open question", p.warn))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(p.muted)
        .child(`${q.sessionName ?? q.sessionId}${q.cwd ? ` · ${q.cwd}` : ""}`)))
    .when(Boolean(q.header), (el) => el.child(div().text_size(11).text_color(p.faint).child(q.header)))
    .child(div().text_size(13).child(q.question))
    .child(h_flex().w_full().gap(6).items_center()
      .children(q.options.map((option, index) => button(
        p,
        `${index + 1}. ${option.label}`,
        (_e, cx) => v.answer(cx, index),
        { disabled: v.busy || !q.agentDir },
      )))
      .when(!q.agentDir, (el) => el.child(div().text_size(11).text_color(p.err).child("no agent folder: answer in the session's own TUI"))));
}

function log(p, v) {
  if (!v.settings.details) return div();
  const rows = v.state.events.slice(0, LOG_ROWS);
  if (!rows.length) {
    return div().px(10).py(6).rounded(p.R.row).bg(p.surface).text_size(12).text_color(p.faint)
      .child("Nothing yet. A question this machine is waiting on is sent to Telegram; an order you type below reaches the shown session.");
  }
  return v_flex().w_full().gap(2)
    .children(rows.map((row) => h_flex().w_full().gap(8).items_center()
      .child(div().flex_none().w(60).text_size(11).text_color(p.faint).child(clock(row.at)))
      .child(chip(p, row.kind ?? "note", p[KIND_COLOR[row.kind] ?? "muted"]))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(p.muted).child(String(row.text ?? "")))));
}

function composer(p, v, cx) {
  return h_flex().w_full().flex_none().px(14).py(10).gap(8).items_center().border_t(1).border_color(p.line)
    .child(div().flex_1().min_w(0).rounded(p.R.row).border(1).border_color(p.lineStrong).bg(p.raised).px(8).py(6)
      .child(Textarea.new(v.input).w_full().text_size(13).line_height(1.4).text_color(p.text).bg(CLEAR)))
    .child(button(p, "Send", (_e, cx) => v.send(cx), { primary: true, disabled: v.busy }));
}

export function screen(p, v, cx) {
  return v_flex().id("root").size_full().min_h(0).bg(p.background).text_color(p.text).text_size(13).line_height(1.5)
    .child(header(p, v, cx))
    .child(div().flex_1().min_h(0).overflow_hidden().child(v_flex().w_full().px(14).gap(10).pb(10)
      .when(Boolean(v.pending), (el) => el.child(blockerCard(p, v, cx)))
      .child(log(p, v))))
    .child(composer(p, v, cx));
}
