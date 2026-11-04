// The least time between two activity reports the daemon takes on one round (ADR 145),
// one value for both sides of the route: src/server.mjs refuses a report inside it, and
// src/ui.mjs splices the value this process resolved into the page's script, so a page
// never books its reports closer together than the route takes them. Read from the
// environment because the checks shorten it; the page takes it when src/ui.mjs is first
// imported, which in the daemon is at startup, the only time its environment is set.

/** Five seconds: the deadline is minutes long, so a report every keystroke buys nothing
 * a report every few seconds does not. */
const DEFAULT_ACTIVITY_MIN_MS = 5_000;

/** `CLAUDE_BOARD_ACTIVITY_MIN_MS`, else the default; zero, negative and unparseable fall
 * back to the default, as every knob in src/server.mjs does. */
export function activityMinMs() {
  const v = Number(process.env.CLAUDE_BOARD_ACTIVITY_MIN_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_ACTIVITY_MIN_MS;
}
