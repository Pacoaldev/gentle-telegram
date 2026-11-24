// Colours for this mod: a Herdr theme role when the theme has it, the token's own hex otherwise,
// so the bridge follows the person's theme and still reads correctly without one.
import { theme } from "herdr";

// name: [fallback hex, Herdr theme role]
const TOKENS = {
  background: ["#0b0a0c", "background"],
  chrome: ["#100a0f", "chrome"],
  surface: ["#171318", "surface"],
  raised: ["#201a21", "raised"],
  hover: ["#28121e", "hover"],
  line: ["#2a2229", "border"],
  lineStrong: ["#563040", "input"],
  text: ["#f4eff2", "foreground"],
  muted: ["#a78e9b", "muted"],
  faint: ["#76616b", "dim"],
  accent: ["#f095c8", "accent"],
  ok: ["#79c98f", "done"],
  warn: ["#e0c27a", "blocked"],
  err: ["#ff718f", "err"],
  info: ["#a9c7ee", "working"],
};

export function palette() {
  let themed = {};
  try {
    const t = theme();
    if (t && typeof t === "object") themed = t;
  } catch {
    themed = {};
  }
  const out = { R: { card: 10, chip: 6, row: 8 } };
  for (const name of Object.keys(TOKENS)) {
    const [hex, role] = TOKENS[name];
    const value = role && typeof themed[role] === "string" ? themed[role] : hex;
    out[name] = typeof value === "string" && value ? value : hex;
  }
  return out;
}
