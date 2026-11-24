// Reachability probe, run by `herdr-app check tests/probe-network`.
// It answers one question the unit tests cannot: can a mod's fetch reach api.telegram.org, and what
// does Telegram say about a token that is deliberately wrong? The answer is written next to the mod
// so the run can be read back without a window (`check` shows no console output from a task).
import { home, writeTextFile } from "herdr";
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";

const URL = "https://api.telegram.org/bot0:probe/getMe";

export default class Probe extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      const line = { at: new Date().toISOString(), url: URL };
      try {
        const response = await fetch(URL, { method: "GET" });
        line.status = response.status;
        line.body = (await response.text()).slice(0, 300);
      } catch (error) {
        line.error = String(error?.message ?? error);
      }
      try {
        await writeTextFile(`${home()}/gentle-telegram-probe.json`, JSON.stringify(line, null, 2));
      } catch {
        // Nothing to do: the check output is the only channel left.
      }
    });
  }

  render() {
    return h_flex().child(div().child("Telegram probe"));
  }
}
