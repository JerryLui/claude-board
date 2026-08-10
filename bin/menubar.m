/* The menu bar status item: the launcher's SECOND child, and a pure HTTP client of the
 * daemon.
 *
 * ADR 72. The status item is not a second bundle and not a second LaunchAgent — it is
 * `claude-board --menubar`, the same CFBundleExecutable launchd already runs, forked and
 * exec'd a second time by bin/launcher.c. One bundle, one signature, one LaunchServices
 * record (QUIRKS.md measured 6908 of those from a second bundle id's worth of throwaway
 * registrations, and a stale one is the "damaged and can't be opened" dialog), and — the
 * reason it is a separate PROCESS rather than a thread of the launcher — a crash in menu
 * bar code kills the menu bar alone. The launcher forks node and blocks in waitpid; it is
 * close to uncrashable, and it stays that way only if nothing that draws is running in it.
 *
 * What this file owns, and what it deliberately does not. It owns a picture: which glyph,
 * how much of the arc is left, whether digits show. It owns NO clock, NO settings and NO
 * notifications — every one of those already lives in the daemon behind
 * `GET /api/pomodoro`, and the whole reason the feature is ~500 lines rather than the
 * ~800 a self-contained menu bar timer costs is that this end of it only reads. Nothing
 * below decides that a work interval became a break: settleBoundary (src/pomodoro.mjs)
 * decides that, on the daemon, exactly as it does for the index widget.
 *
 * Two facts about the process this runs in, both decided in bin/launcher.c and both
 * load-bearing for everything below:
 *
 *   - It was reached by fork + execve, never by fork-and-call. CoreFoundation and the
 *     Objective-C runtime are documented-unsafe in a forked child that has not exec'd
 *     ("The process has forked and you cannot use this CoreFoundation functionality
 *     safely"), which is a fatal, not a theoretical, objection to AppKit here.
 *   - Its environment is the same one the daemon gets: the launcher's compiled-in
 *     overrides plus the passthrough allowlist, never the parent's. So HOME is the
 *     reader's real home (which is how the local secret at ~/.config/claude-board/secret
 *     is findable) and CLAUDE_BOARD_PORT is the daemon's port if the operator set one.
 *     CLAUDE_BOARD_SECRET_FILE is deliberately NOT among them — the secret's path is
 *     derived from HOME here for the same reason it is for the daemon.
 *
 * The icon is a TEMPLATE IMAGE — an alpha mask the system colours itself — and that one
 * decision is why there is no palette anywhere below. The four phases are told apart by
 * shape and weight, never by hue, so light, dark, the highlighted menu bar, Increase
 * Contrast and Reduce Transparency are all the system's problem rather than this file's.
 * See cb_image for the longer version of why the alternative does not work.
 *
 * The shape of the file, top to bottom: signals, then the pure derivation (C functions
 * from one HTTP response to a display state and to the popover's own row labels, with no
 * AppKit anywhere near them), then the HTTP client that feeds them, then the drawing and
 * the popover that consume them, then the two entry points. That split is not tidiness —
 * it is what makes the interesting half testable. There is no headless way to assert a
 * status item's title OR a popover's contents — both exist only inside a running
 * NSApplication with a window server session — so the AppKit layer is kept as thin a
 * renderer as it can be, and `--menubar --probe` (bottom of this file) exposes everything
 * else to a node check without drawing anything at all.
 *
 * The popover deserves its own warning, because it is the half with no automated test:
 * every control below is a stock AppKit one at its default appearance. That is not
 * laziness, it is the same call the template image made — an NSButton nobody styled is
 * an NSButton that is right in light, in dark, under Increase Contrast and under Reduce
 * Transparency, with a focus ring and an accessibility role, for free and forever. The
 * popover's own material and background are left alone for the same reason.
 */
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>

/* Set from a signal handler, read only by the run loop below — a `sig_atomic_t` and a
 * plain store are the whole of what a handler may safely do. The same shape bin/notify.m
 * uses for its click-serving mode, and for the same reason: a process that lives for the
 * length of a login session is one launchd will signal, one the reader may kill by hand,
 * and one that must not need SIGKILL to stop. */
static volatile sig_atomic_t stop_requested = 0;

/* bin/launcher.c's own board-URL scanner, compiled into this same binary and declared
 * here rather than in a header, on exactly the footing cb_notify and cb_menubar are
 * declared over there: one definition, one build, a signature short enough to check
 * against the other file by eye.
 *
 * Criterion 6's rows open a board, and the URL they open arrives over HTTP from
 * `GET /api/waiting` rather than out of argv — but it reaches +[NSWorkspace openURL:]
 * either way, and LaunchServices acts on any scheme it can resolve (`file:`, an app's
 * custom scheme, a remote `https:` page). So it is filtered by the SAME function the
 * banner's click target is filtered by, for the same reason and to the same shape:
 * `http://<loopback>[:<port>]/b/<id>[#<fragment>]`, port checked against this process's
 * own. A second pattern written in Objective-C would be a second opinion about what
 * `/b/../../etc` means, and the two would drift the first time one was tightened.
 *
 * No credential travels with the URL (ADR 57): the browser's own long-lived session is
 * what authorizes the page, and a browser holding none lands on the refusal page
 * src/render.mjs already renders. */
extern int cb_is_board_url(const char *s, int expected_port);

static void cb_stop(int sig) {
  (void)sig;
  stop_requested = 1;
}

/* The set bin/launcher.c forwards, minus nothing: launchd stops a job with SIGTERM, the
 * launcher forwards whatever it was sent to both children, and a terminal sends SIGINT or
 * SIGQUIT when someone runs this by hand while debugging. SIGKILL is absent because it
 * cannot be caught — and criterion 15 is precisely that a SIGKILL here costs the item and
 * nothing else, which is the launcher's side of the arrangement, not this file's. */
static void install_stop_handlers(void) {
  static const int SIGNALS[] = { SIGTERM, SIGINT, SIGHUP, SIGQUIT };
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = cb_stop;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_RESTART;
  for (size_t i = 0; i < sizeof(SIGNALS) / sizeof(SIGNALS[0]); i++) {
    (void)sigaction(SIGNALS[i], &sa, NULL);
  }
}

/* --- The cadence ---------------------------------------------------------------------
 *
 * Both numbers are the index widget's own, and they are copied rather than chosen because
 * criterion 1 is stated RELATIVE to that widget: "within one second of the widget on the
 * index page". src/indexpage.mjs polls `GET /api/pomodoro` every POMODORO_POLL_MS (15s)
 * and repaints locally every second from the cached document plus a clock offset. Two
 * surfaces that repaint on the same period from the same daemon clock cannot drift apart
 * by more than that period, whatever either machine's own clock is doing. Anything faster
 * here would be a second cadence to keep in step with the first; anything slower would
 * miss the criterion by construction. */
static const double CB_POLL_S = 15.0;
static const double CB_TICK_S = 1.0;

/* How long a request may hang before it counts as no answer. Shorter than the poll
 * period on purpose: a request still outstanding when the next one is due would either
 * stack up or have to be cancelled, and 5s is already an eternity for a loopback GET the
 * daemon answers by reading one small JSON file. */
static const double CB_REQUEST_TIMEOUT_S = 5.0;

/* Criterion 9's "later stops answering", as a number. Three poll periods since the last
 * SUCCESSFUL answer, i.e. two consecutive misses before the item dims.
 *
 * Not one period: a single dropped request — the daemon being restarted by `install.sh`'s
 * bootout → bootstrap → kickstart, a laptop coming back from sleep mid-poll — is the
 * common case, and dimming for it would make the item flicker on every reinstall. Not
 * five either: "the daemon has gone" should be visible inside a minute, or the reader
 * spends that minute trusting a countdown that stopped being true. 45s is the smallest
 * value that survives one lost poll and still lands inside that minute.
 *
 * Note what this does NOT do: it never destroys the item. Criterion 9 is explicit that a
 * silent daemon dims and drops the digits rather than disappearing, because at that point
 * disappearing would be indistinguishable from the reader having hidden it. */
static const double CB_STALE_AFTER_MS = 45000.0;

/* The daemon's default port, matching src/handoff.mjs's DEFAULT_PORT. CLAUDE_BOARD_PORT overrides it and
 * is on bin/launcher.c's passthrough allowlist, so an operator who moved the daemon moved
 * this too with no second setting to remember. */
static const int CB_DEFAULT_PORT = 7391;

/* --- The derivation, which is the part with no AppKit in it --------------------------
 *
 * One HTTP response in, one display state out. Everything the item draws is decided here
 * and nowhere else, so the renderer below is a switch over these fields and the node
 * check at test/check-menubar-client.mjs can pin every state through `--menubar --probe`
 * without a window server anywhere in the picture.
 *
 * The phase vocabulary is the daemon's, exactly: "work", "break", "longBreak". There is
 * no "idle" phase and no "paused" phase in the protocol — idle is `timer === null` and
 * paused is `timer.paused` — so CB_IDLE below is this file's own name for the absence of
 * a timer, never something parsed off the wire. */
typedef enum {
  CB_IDLE = 0,
  CB_WORK,
  CB_BREAK,
  CB_LONG_BREAK,
} cb_phase;

/* The `timer` object of a /api/pomodoro response, flattened. Two shapes on the wire —
 * `{ phase, deadline, paused: false }` and `{ phase, remainingMs, paused: true }` — and
 * `running = 0` for the third, `timer: null`. */
typedef struct {
  int running;
  cb_phase phase;
  int paused;
  double deadline_ms;   /* epoch ms; meaningful only while !paused */
  double remaining_ms;  /* meaningful only while paused — pauseTimer froze it server-side */
} cb_timer;

/* The `settings` fields this file reads, and only those. The four durations are what turn
 * a remaining time into the arc's fraction; the two booleans are ticket 01's additions. */
typedef struct {
  double work_ms;
  double break_ms;
  double long_break_ms;
  int countdown;  /* settings.menubarCountdown */
  int hidden;     /* settings.menubarHidden */
} cb_settings;

/* What the item looks like. Deliberately flat and copyable: it crosses into a drawing
 * block by value, which is what keeps the renderer from reaching back for anything the
 * derivation did not decide for it. */
typedef struct {
  int answered;       /* has the daemon answered inside CB_STALE_AFTER_MS */
  int hidden;         /* settings.menubarHidden — the item exists but is not visible */
  cb_phase phase;
  int paused;
  int arc;            /* draw the circle as a depleting arc rather than whole */
  int filled;         /* the long break's heavier circle */
  int muted;          /* idle and paused: the widget's own turned-down weight */
  double fraction;    /* 0..1 of the interval still to run — the arc's sweep */
  long remaining_s;   /* rounded the way formatCountdown rounds */
  int countdown;      /* would the digits be on screen */
  char text[16];      /* "MM:SS", or "" when there is no interval to count */
} cb_display;

static double cb_phase_length_ms(cb_phase phase, const cb_settings *settings) {
  if (phase == CB_WORK) return settings->work_ms;
  if (phase == CB_BREAK) return settings->break_ms;
  if (phase == CB_LONG_BREAK) return settings->long_break_ms;
  return 0.0;
}

/* The whole of the picture, derived.
 *
 * `now_ms` is the DAEMON's clock, not this machine's: every caller passes
 * `localNow + (daemonNow - localNow at the last answer)`, the same one-offset-per-response
 * correction src/indexpage.mjs's fetchPomodoro applies, so a machine whose wall clock has
 * drifted still counts down in step with the daemon and with every open tab. It is a
 * parameter rather than something read in here for the same reason pomodoroRemainingMs
 * takes `browserNow`: a check can then pin this against a fixed clock instead of racing
 * the real one.
 *
 * `answered = 0` is the stale case, and the caller freezes `now_ms` at the last answer's
 * own `now` when it passes it — so a daemon that went quiet leaves the arc stopped where
 * it was rather than draining to empty against a document nothing is refreshing. That
 * one line of policy is the caller's; everything else about staleness is here: the digits
 * go, the shape stays.
 *
 * Four appearances out of the widget's two shapes (ADR 80), and NOT ONE OF THEM IS A
 * COLOUR: idle is the tomato with a plain undepleted circle and no arc; work is the
 * tomato with the depleting arc; a short break is the bars glyph with the depleting arc;
 * a long break is the bars glyph with that arc on a FILLED circle. The icon is a template
 * image (see cb_image below), so the system owns the hue and this function has only shape
 * and weight to spend — which is what these four were picked against. Paused draws the
 * glyph its phase would draw, at the muted weight, with the arc frozen — which is also
 * the only thing separating idle from paused-in-work, since both are the muted tomato:
 * idle has no arc at all, paused has a stopped one. */
static cb_display cb_derive(int answered, const cb_timer *timer, const cb_settings *settings,
                            double now_ms) {
  cb_display d;
  memset(&d, 0, sizeof(d));
  d.answered = answered ? 1 : 0;
  d.hidden = settings->hidden ? 1 : 0;
  /* A full circle, so the idle glyph below is the widget's plain one rather than a
   * zero-length arc that would read as an interval about to expire. */
  d.fraction = 1.0;

  if (!timer->running) {
    /* Idle. Muted, and no countdown at all — countdown text appears only while a timer
     * exists, so an idle item is the icon alone whatever menubarCountdown says. The
     * widget's own idle row says the same thing differently ("Idle (25 min)"); there is
     * no room for that in a menu bar, and a duration that is not counting down would read
     * as one that is. */
    d.phase = CB_IDLE;
    d.muted = 1;
    return d;
  }

  d.phase = timer->phase;
  d.paused = timer->paused ? 1 : 0;
  d.arc = 1;
  d.filled = (timer->phase == CB_LONG_BREAK) ? 1 : 0;
  d.muted = d.paused;

  double remaining = timer->paused ? timer->remaining_ms : timer->deadline_ms - now_ms;
  if (remaining < 0.0) remaining = 0.0;

  /* The arc is remaining-over-configured, not remaining-over-elapsed: the denominator is
   * the phase's CURRENT setting, which is the same number restartTimer mints a deadline
   * from. A reader who shortens the work interval mid-interval therefore sees an arc that
   * is already past where it would have been, which is honest — the interval they are in
   * is longer than the one they just configured, and the digits say so too. */
  double total = cb_phase_length_ms(timer->phase, settings);
  d.fraction = total > 0.0 ? remaining / total : 0.0;
  if (d.fraction > 1.0) d.fraction = 1.0;
  if (d.fraction < 0.0) d.fraction = 0.0;

  /* llround, matching formatCountdown's own Math.round: the two surfaces have to agree on
   * which second they are showing, and floor-vs-round is a whole second of disagreement
   * for half of every second. */
  d.remaining_s = (long)llround(remaining / 1000.0);
  snprintf(d.text, sizeof(d.text), "%02ld:%02ld", d.remaining_s / 60, d.remaining_s % 60);

  /* Criterion 11: turning the setting off leaves the icon and removes the text. The text
   * is derived either way above — this flag alone decides whether it reaches the button,
   * so the switch costs a redraw and never a restart. A silent daemon drops it too
   * (criterion 9): digits from a document nothing is refreshing are the one part of the
   * picture that would be actively wrong rather than merely stale. */
  d.countdown = (settings->countdown && answered) ? 1 : 0;
  return d;
}

/* --- The popover's own pure half ------------------------------------------------------
 *
 * Everything below decides WORDS and COUNTS, and not one line of it touches AppKit. The
 * popover proper (further down) is then a stack of stock controls whose titles come from
 * here, which is the same split cb_derive above buys for the icon: the untestable half
 * stays as small as it can be, and the rules a reader could get wrong — how many rows,
 * what the overflow says, which action the one button performs — are pinned by
 * test/check-menubar-client.mjs through `--menubar --probe`.
 *
 * Fixed-size buffers and snprintf throughout, never a heap string: a board title is
 * arbitrary text from the reader's own machine, and a bounded copy of it into a struct
 * that is passed BY VALUE is both the smallest code and the one with nothing to free on
 * a path that runs every fifteen seconds for a login session. */

/* Five rows, and this cap is THIS FILE's rule rather than the route's. `GET /api/waiting`
 * is uncapped by design (src/server.mjs says so in as many words) precisely so the client
 * drawing the list can pick its own maximum and still have a `total` to say "and N more"
 * with. Five, because an uncapped section is a popover with no maximum height, and
 * because the overflow row has somewhere to send you. */
#define CB_WAITING_MAX 5

/* A title long enough to fill the popover's width twice over is a real thing a board can
 * be called. Elided to this many BYTES (see cb_elide for why bytes are safe here) so the
 * row stays one line and the round number — the half that says which round is waiting —
 * is never the part that gets truncated away. */
#define CB_TITLE_MAX 40

typedef struct {
  char label[CB_TITLE_MAX + 40];  /* "<elided title> · round N" */
  char url[220];                  /* the route's own `url`, already board-URL-checked */
} cb_waiting_row;

typedef struct {
  cb_waiting_row rows[CB_WAITING_MAX];
  int count;                /* rows actually held, 0..CB_WAITING_MAX */
  int total;                /* what the route said, uncapped — the overflow's numerator */
  int more;                 /* total - count, floored at 0 */
  char more_label[40];      /* "N more waiting", or "" when there is no overflow row */
} cb_waiting;

/* Copy `s` into `out`, cutting it at `max_bytes` with an ellipsis if it is longer.
 *
 * The cut is nudged back off a UTF-8 CONTINUATION byte, and that is not a nicety: half a
 * character is not a string, +[NSString stringWithUTF8String:] returns nil for one, and
 * -[NSButton setTitle:] raises on nil. A board titled with an emoji or a Swedish å is
 * ordinary here, so this is the common case rather than the adversarial one. */
static void cb_elide(const char *s, size_t max_bytes, char *out, size_t out_len) {
  size_t len = strlen(s);
  if (len <= max_bytes) {
    snprintf(out, out_len, "%s", s);
    return;
  }
  size_t cut = max_bytes;
  while (cut > 0 && ((unsigned char)s[cut] & 0xc0) == 0x80) cut--;
  snprintf(out, out_len, "%.*s…", (int)cut, s);
}

/* Criterion 6's row, spelled: "thread title and round". The separator is the widget's own
 * middle dot, and the round is spelled out rather than abbreviated to "#3" because the
 * accessibility label is this same string — a screen reader saying "number three" for a
 * hash is a worse row than a slightly longer one. */
static void cb_row_label(const char *title, long round, char *out, size_t out_len) {
  char elided[CB_TITLE_MAX + 8];
  cb_elide(title, CB_TITLE_MAX, elided, sizeof(elided));
  snprintf(out, out_len, "%s · round %ld", elided, round);
}

/* How many boards the overflow row has to account for. `listed` is what this process
 * actually holds (already capped, and possibly short of the route's own count if a row
 * carried a URL cb_is_board_url refused); `total` is the route's uncapped number. A row
 * this build dropped is counted as overflow rather than silently forgotten — the index
 * page can show it even when this popover cannot. */
static int cb_overflow_count(int listed, int total) {
  int shown = listed < CB_WAITING_MAX ? listed : CB_WAITING_MAX;
  if (shown < 0) shown = 0;
  int more = total - shown;
  return more > 0 ? more : 0;
}

static void cb_overflow_label(int more, char *out, size_t out_len) {
  if (more <= 0) {
    out[0] = '\0';
    return;
  }
  if (more == 1) snprintf(out, out_len, "1 more waiting");
  else snprintf(out, out_len, "%d more waiting", more);
}

/* The waiting section's caption, which carries the COUNT. The Solution the spec opens
 * with says the dropdown carries "a count of boards waiting for an answer", and the
 * overflow row alone does not deliver that: it appears only past the fifth, so the
 * common case — one or two waiting — showed a bare heading and no number anywhere.
 *
 * `total`, not the number of rows drawn, so the count means the same thing whether or
 * not the cap is in play: "3 waiting" beside three rows, "7 waiting" beside five rows
 * and an overflow row that accounts for the other two. */
static void cb_waiting_caption(int total, char *out, size_t out_len) {
  if (total <= 0) snprintf(out, out_len, "Nothing waiting");
  else if (total == 1) snprintf(out, out_len, "1 waiting for an answer");
  else snprintf(out, out_len, "%d waiting for an answer", total);
}

/* The popover's one line of text about the Timer. The item's own icon and digits are
 * beside it on the menu bar, so this says the thing the icon cannot: the phase in words.
 *
 * "Short break" and "Long break" rather than the wire's `break`/`longBreak`, and a
 * separate `paused` word rather than a fourth phase name, because paused is a state of a
 * phase and not a phase — the same distinction cb_derive keeps. */
static void cb_status_label(cb_display d, char *out, size_t out_len) {
  if (!d.answered) {
    /* Criterion 9 in words. The buttons below stay live: a daemon that has stopped
     * answering may well be back by the time the reader presses one, and a popover that
     * greyed itself out would be a second thing to get wrong about a state that already
     * has an appearance. */
    snprintf(out, out_len, "No answer from the daemon");
    return;
  }
  if (d.phase == CB_IDLE) {
    snprintf(out, out_len, "Idle");
    return;
  }
  const char *phase = d.phase == CB_WORK ? "Work" : (d.phase == CB_BREAK ? "Short break" : "Long break");
  if (d.paused) snprintf(out, out_len, "%s · paused · %s", phase, d.text);
  else snprintf(out, out_len, "%s · %s", phase, d.text);
}

/* --- What the buttons do --------------------------------------------------------------
 *
 * Six actions, and the table below is the whole vocabulary: every POST this process can
 * make is one of these six route literals, chosen by an enum value, never by a string
 * anything outside this file supplied.
 *
 * RESET IS NOT HERE, AND ITS ABSENCE IS THE FEATURE (criterion 8). Reset ends the whole
 * loop and zeroes the cycle; the index widget already made the call to bury it inside the
 * settings panel, and a popover is not the place to hand that a second front door — a
 * menu bar item is clicked by accident in a way a collapsed settings panel is not.
 * Forward and Restart stay, because neither destroys anything: forward advances the
 * boundary the daemon was going to cross anyway, restart re-mints the interval that is
 * already running. If a future reader adds a seventh row here, `/api/pomodoro/reset` is
 * still the one route that must not appear in this array, and
 * test/check-menubar-client.mjs asserts exactly that against this file's own bytes. */
typedef enum {
  CB_ACTION_START = 0,
  CB_ACTION_PAUSE,
  CB_ACTION_RESUME,
  CB_ACTION_FORWARD,
  CB_ACTION_RESTART,
  CB_ACTION_HIDE,
} cb_action;

static const char *const CB_ACTION_PATHS[] = {
  "/api/pomodoro/ensure",
  "/api/pomodoro/pause",
  "/api/pomodoro/resume",
  "/api/pomodoro/forward",
  "/api/pomodoro/restart",
  "/api/pomodoro/settings",
};

/* Which action the ONE primary button performs, and it is src/indexpage.mjs's
 * pomodoroSwitchAction rewritten in C rather than a second opinion about what "the
 * button" means: no timer → start, paused → resume, otherwise → pause. Mirrored rather
 * than invented, because the two surfaces are looking at the same daemon and a reader who
 * learned the widget's button must not have to learn this one separately.
 *
 * `d.phase == CB_IDLE` is cb_derive's own spelling of the widget's `!timer` — the
 * protocol has no idle phase, so the two conditions are the same condition. */
static cb_action cb_switch_action(cb_display d) {
  if (d.phase == CB_IDLE) return CB_ACTION_START;
  return d.paused ? CB_ACTION_RESUME : CB_ACTION_PAUSE;
}

/* One word, where the widget's aria-label says "Start pomodoro". The popover's line above
 * the button already names the phase, so the sentence would be said twice — but the
 * accessibility label DOES take the widget's full spelling (see the popover below), since
 * a screen reader reads the button without the line above it. */
static const char *cb_switch_label(cb_action action) {
  if (action == CB_ACTION_START) return "Start";
  if (action == CB_ACTION_RESUME) return "Resume";
  return "Pause";
}

/* --- The HTTP client ------------------------------------------------------------------
 *
 * A pure client of `GET http://127.0.0.1:<port>/api/pomodoro`, authorized by the local
 * secret in the `x-claude-board-secret` header — the same credential the MCP shim holds,
 * and the reason SECURITY.md now names this process. No new route was added for the item:
 * a native client sends no `Origin` header, which the same-origin gate already treats as
 * same-origin, and the secret already authorizes every read and write in the pomodoro
 * set. */

/* The secret's path is derived from HOME, never read from CLAUDE_BOARD_SECRET_FILE —
 * that variable is a testing seam and bin/launcher.c deliberately keeps it out of this
 * child's environment, so that anything able to rewrite the LaunchAgent plist still
 * cannot point a process holding the reader's Documents grant at a credential of its own
 * choosing. Exactly the derivation src/secret.mjs's secretPath() performs. */
static NSString *cb_secret_path(void) {
  NSString *home = [[[NSProcessInfo processInfo] environment] objectForKey:@"HOME"];
  if (home.length == 0) return nil;
  return [home stringByAppendingPathComponent:@".config/claude-board/secret"];
}

/* Cached between polls, and dropped on ANY failed poll rather than held for the life of
 * the login session. The secret can be rotated underneath a process that started hours
 * ago — a reinstall, a reader clearing ~/.config/claude-board by hand — and a client that
 * cached it once would then spend the rest of the day being refused with no way back
 * short of a logout. Re-reading costs one open() of a 64-byte file per failed poll, at
 * most one every CB_POLL_S, which is not a busy loop by any measure. */
static NSString *cb_cached_secret = nil;

static NSString *cb_secret(void) {
  if (cb_cached_secret != nil) return cb_cached_secret;
  NSString *file = cb_secret_path();
  if (file == nil) return nil;
  NSString *raw = [NSString stringWithContentsOfFile:file encoding:NSUTF8StringEncoding error:NULL];
  NSString *trimmed =
      [raw stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  cb_cached_secret = trimmed.length > 0 ? trimmed : nil;
  return cb_cached_secret;
}

static void cb_forget_secret(void) { cb_cached_secret = nil; }

static int cb_port(void) {
  NSString *value = [[[NSProcessInfo processInfo] environment] objectForKey:@"CLAUDE_BOARD_PORT"];
  int port = value != nil ? [value intValue] : 0;
  return (port > 0 && port <= 65535) ? port : CB_DEFAULT_PORT;
}

static double cb_now_ms(void) { return [[NSDate date] timeIntervalSince1970] * 1000.0; }

/* DEFAULT_SETTINGS (src/pomodoro.mjs), duplicated here for exactly one purpose: a probe
 * or a tick that has no answer yet still derives a well-formed display rather than one
 * built on zeroes, where a zero denominator would make every arc empty. Nothing on the
 * ordinary path ever draws these — the item is not created until a real response has
 * replaced them (criterion 9). */
static void cb_defaults(cb_timer *timer, cb_settings *settings) {
  memset(timer, 0, sizeof(*timer));
  settings->work_ms = 25.0 * 60000.0;
  settings->break_ms = 5.0 * 60000.0;
  settings->long_break_ms = 15.0 * 60000.0;
  settings->countdown = 1;
  settings->hidden = 0;
}

/* The protocol's three phase spellings and nothing else. An unrecognised one — a future
 * daemon that grew a fourth phase talking to an install that predates it — is reported as
 * "no timer", which draws the calm idle glyph rather than an arc against a length this
 * build cannot know. The same shape bin/launcher.c's MESSAGES lookup already takes for an
 * unrecognised notify phase. */
static int cb_phase_from(NSString *name, cb_phase *out) {
  if ([name isEqualToString:@"work"]) { *out = CB_WORK; return 1; }
  if ([name isEqualToString:@"break"]) { *out = CB_BREAK; return 1; }
  if ([name isEqualToString:@"longBreak"]) { *out = CB_LONG_BREAK; return 1; }
  return 0;
}

static double cb_number(NSDictionary *dict, NSString *key, double fallback) {
  id value = dict[key];
  return [value isKindOfClass:[NSNumber class]] ? [value doubleValue] : fallback;
}

static int cb_bool(NSDictionary *dict, NSString *key, int fallback) {
  id value = dict[key];
  return [value isKindOfClass:[NSNumber class]] ? ([value boolValue] ? 1 : 0) : fallback;
}

/* One request, synchronously, and the only place in this file that speaks HTTP. NEVER
 * call this on the main thread while the item is up: it blocks, and the whole point of
 * the poll queue below is that the network half cannot be starved by — or starve — a menu
 * or popover tracking on the main run loop. That applies to the popover's own actions as
 * much as to the poll: every one of them hops onto the poll queue first, precisely
 * because a reader who pressed Pause while the daemon was wedged would otherwise be
 * holding a frozen popover open. The one caller that does run it on the main thread is
 * `--menubar --probe`, which has no run loop, no item and nothing else to do.
 *
 * `body` non-nil makes it a POST with a JSON content-type; nil is a bodyless request of
 * whatever `method` says. Returns the response body on a 200 and nil on anything else —
 * a refusal, a 404, a timeout and a daemon that is not there are all the same answer to
 * every caller here, which is "no", and none of them has a second thing to do about it.
 *
 * `path` is ALWAYS a compiled-in literal — /api/pomodoro, /api/waiting, or one of
 * CB_ACTION_PATHS above. Nothing this process reads over the network or takes from argv
 * ever reaches it, which is why building the URL by format string here is safe. */
static NSData *cb_request(NSString *method, const char *path, NSData *body) {
  NSString *secret = cb_secret();
  if (secret == nil) return nil;

  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%d%s",
                                                               cb_port(), path]];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url
                                                        cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                                    timeoutInterval:CB_REQUEST_TIMEOUT_S];
  [request setValue:secret forHTTPHeaderField:@"x-claude-board-secret"];
  request.HTTPMethod = method;
  if (body != nil) {
    request.HTTPBody = body;
    /* Only the settings route reads a body, and src/server.mjs's readJsonBody refuses
     * anything but `application/json` with a 415 — deliberately, since that content-type
     * is the one a cross-origin page cannot send without a preflight. The five bodyless
     * actions send no content-type at all and must not: they are documented as answerable
     * by a one-line `curl` with nothing to construct. */
    [request setValue:@"application/json" forHTTPHeaderField:@"content-type"];
  }

  __block NSData *reply = nil;
  __block NSInteger status = 0;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  NSURLSessionDataTask *task = [[NSURLSession sharedSession]
      dataTaskWithRequest:request
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
          if (error == nil && [response isKindOfClass:[NSHTTPURLResponse class]]) {
            status = [(NSHTTPURLResponse *)response statusCode];
            reply = data != nil ? data : [NSData data];
          }
          dispatch_semaphore_signal(done);
        }];
  [task resume];
  /* A second deadline outside NSURLSession's own, because timeoutInterval bounds the
   * request and not this wait: a session that never calls back at all would otherwise
   * park the poll queue for good, and every later poll behind it. */
  int64_t wait_ns = (int64_t)((CB_REQUEST_TIMEOUT_S + 2.0) * (double)NSEC_PER_SEC);
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, wait_ns)) != 0) {
    [task cancel];
    cb_forget_secret();
    return nil;
  }
  /* Any failure re-reads the secret next time, not just a 401 — a rotated secret and a
   * daemon that was restarting present identically from here, and the cheap recovery is
   * correct for both. */
  if (status != 200 || reply == nil) {
    cb_forget_secret();
    return nil;
  }
  return reply;
}

/* `GET /api/pomodoro`. Fills the outputs with defaults first and returns whether the
 * daemon actually answered, so a caller never has to decide what an unanswered call left
 * behind. */
static BOOL cb_fetch(cb_timer *timer_out, cb_settings *settings_out, double *now_out) {
  cb_defaults(timer_out, settings_out);
  *now_out = cb_now_ms();

  NSData *body = cb_request(@"GET", "/api/pomodoro", nil);
  if (body == nil) return NO;

  NSDictionary *doc = [NSJSONSerialization JSONObjectWithData:body options:0 error:NULL];
  if (![doc isKindOfClass:[NSDictionary class]]) return NO;

  NSDictionary *settings = doc[@"settings"];
  if ([settings isKindOfClass:[NSDictionary class]]) {
    settings_out->work_ms = cb_number(settings, @"workMin", 25.0) * 60000.0;
    settings_out->break_ms = cb_number(settings, @"breakMin", 5.0) * 60000.0;
    settings_out->long_break_ms = cb_number(settings, @"longBreakMin", 15.0) * 60000.0;
    settings_out->countdown = cb_bool(settings, @"menubarCountdown", 1);
    settings_out->hidden = cb_bool(settings, @"menubarHidden", 0);
  }

  /* `now` is the daemon's own clock and the only one this file trusts for a deadline. */
  *now_out = cb_number(doc, @"now", *now_out);

  NSDictionary *timer = doc[@"timer"];
  if ([timer isKindOfClass:[NSDictionary class]]) {
    cb_phase phase = CB_IDLE;
    if (cb_phase_from(timer[@"phase"], &phase)) {
      timer_out->running = 1;
      timer_out->phase = phase;
      timer_out->paused = cb_bool(timer, @"paused", 0);
      timer_out->deadline_ms = cb_number(timer, @"deadline", 0.0);
      timer_out->remaining_ms = cb_number(timer, @"remainingMs", 0.0);
    }
  }
  return YES;
}

/* A UTF-8 C string out of whatever JSON handed over, or "" — never nil, and never a
 * pointer into a temporary that has gone away by the time it is used. Every string that
 * crosses from the wire into the fixed-size buffers above goes through here. */
static void cb_copy_string(id value, char *out, size_t out_len) {
  out[0] = '\0';
  if (![value isKindOfClass:[NSString class]]) return;
  const char *utf8 = [(NSString *)value UTF8String];
  if (utf8 != NULL) snprintf(out, out_len, "%s", utf8);
}

/* `GET /api/waiting` → the popover's rows, capped and labelled.
 *
 * The cap is applied HERE rather than by the route, which is uncapped by design: this is
 * the client that draws a popover, so the maximum height is its rule to make, and `total`
 * is what lets the overflow row say how many it is not showing.
 *
 * Fetched on every poll rather than only when the popover opens, and that is not
 * wastefulness — a round leaves this list when it is ANSWERED or when its wait LAPSES,
 * neither of which sends this process anything, so the only honest way to hold the list
 * is to keep asking. It is one loopback GET beside the one already going out.
 *
 * Returns NO on any failure and leaves `*out` untouched, so a poll that lost the daemon
 * for one period keeps the rows it had rather than blanking a list the reader may be
 * about to open. */
static BOOL cb_fetch_waiting(cb_waiting *out) {
  NSData *body = cb_request(@"GET", "/api/waiting", nil);
  if (body == nil) return NO;
  NSDictionary *doc = [NSJSONSerialization JSONObjectWithData:body options:0 error:NULL];
  if (![doc isKindOfClass:[NSDictionary class]]) return NO;
  NSArray *waiting = doc[@"waiting"];
  if (![waiting isKindOfClass:[NSArray class]]) return NO;

  cb_waiting built;
  memset(&built, 0, sizeof(built));
  built.total = (int)cb_number(doc, @"total", (double)waiting.count);

  int port = cb_port();
  for (NSDictionary *entry in waiting) {
    if (built.count >= CB_WAITING_MAX) break;
    if (![entry isKindOfClass:[NSDictionary class]]) continue;
    char url[sizeof(built.rows[0].url)];
    cb_copy_string(entry[@"url"], url, sizeof(url));
    /* Checked on the way IN as well as on the way out (see the row's action in the
     * popover): a row whose URL this build cannot recognise is not drawn at all, because
     * a row that refuses to open when pressed is worse than one that was never there.
     * The overflow count still accounts for it — cb_overflow_count works off `total`. */
    if (!cb_is_board_url(url, port)) continue;
    /* Four times the elision budget, so this buffer's own truncation can only ever land
     * far past the point cb_row_label will cut anyway — which is what keeps the
     * multi-byte safety a property of cb_elide alone rather than of two places at once. */
    char title[CB_TITLE_MAX * 4];
    cb_copy_string(entry[@"title"], title, sizeof(title));
    if (title[0] == '\0') snprintf(title, sizeof(title), "(untitled)");
    long round = (long)cb_number(entry, @"round", 0.0);
    cb_row_label(title, round, built.rows[built.count].label, sizeof(built.rows[0].label));
    snprintf(built.rows[built.count].url, sizeof(built.rows[0].url), "%s", url);
    built.count++;
  }
  built.more = cb_overflow_count(built.count, built.total);
  cb_overflow_label(built.more, built.more_label, sizeof(built.more_label));
  *out = built;
  return YES;
}

/* One of the six actions, posted. Bodyless for the five Timer controls — src/server.mjs
 * reads no body on those branches at all, which is what makes a native client with
 * nothing to say a first-class caller of them — and one compiled-in JSON literal for the
 * hide.
 *
 * No new API was added for any of this: a native client sends no `Origin` header, which
 * the same-origin gate already treats as same-origin, and the local secret already
 * authorizes every write in the pomodoro set.
 *
 * Criterion 12's hide is a COMMAND rather than a settings form, and that distinction is
 * the whole of why it is allowed to exist beside "no setting is editable from the menu
 * bar": it writes one boolean that only this surface has an opinion about, it is
 * reversible from the index page's own panel, and it needs no restart machinery — the
 * poll already honours `settings.menubarHidden` on every pass, and this process never
 * exits when hidden, so there is always something left for the setting to reach. */
static BOOL cb_perform(cb_action action) {
  NSData *body = nil;
  if (action == CB_ACTION_HIDE) {
    body = [@"{\"menubarHidden\":true}" dataUsingEncoding:NSUTF8StringEncoding];
  }
  NSData *reply = cb_request(@"POST", CB_ACTION_PATHS[action], body);
  return reply != nil;
}

/* --- The state the two timers share ---------------------------------------------------
 *
 * Written by the poll queue, read by the main thread's tick. A lock rather than a hop
 * onto the main queue, because a main-queue block is exactly what QUIRKS.md measured does
 * not run while a status item's menu or popover is tracking — and ticket 05 adds the
 * popover that makes that bite. Nothing here is held across a call that can block. */
static NSLock *cb_state_lock = nil;
static cb_timer cb_state_timer;
static cb_settings cb_state_settings;
static cb_waiting cb_state_waiting;        /* criterion 6's rows, as of the last poll */
static double cb_state_daemon_now = 0.0;   /* the daemon's clock at the last answer */
static double cb_state_offset = 0.0;       /* daemonNow - localNow, at the last answer */
static double cb_state_answered_at = 0.0;  /* local clock at the last answer */
static int cb_state_answered_once = 0;
/* Debounces the boundary re-fetch below, cleared by every successful poll — the same
 * pomodoroZeroFetched flag src/indexpage.mjs's tickPomodoro carries, for the same reason. */
static int cb_state_zero_fetched = 0;

/* The serial queue every request in this process goes out on, poll and popover action
 * alike. File-scope rather than a local of cb_menubar because the popover's buttons need
 * it: a POST from a button's action must land on the SAME queue as the poll, or the two
 * could be in flight against the daemon at once and the poll could overwrite the state
 * the POST just changed. Serial, so "post, then re-read" is an ordering this file gets
 * for free rather than one it has to arrange.
 *
 * nil in the probe, which has no queue and no run loop and does its one request straight
 * on the main thread. Every dispatch onto it is guarded accordingly. */
static dispatch_queue_t cb_poll_queue = nil;

static void cb_poll_once(void) {
  cb_timer timer;
  cb_settings settings;
  double daemon_now = 0.0;
  double before = cb_now_ms();
  BOOL answered = cb_fetch(&timer, &settings, &daemon_now);
  if (!answered) return;

  /* Second, and only once the pomodoro half has answered: two GETs against a daemon that
   * is not there would double the time a poll spends failing for no more information than
   * the first failure already gave. Its own failure is not this poll's failure — the item
   * draws from the timer, and a waiting list that could not be refreshed is stale rather
   * than wrong. */
  cb_waiting waiting;
  BOOL have_waiting = cb_fetch_waiting(&waiting);

  [cb_state_lock lock];
  if (have_waiting) cb_state_waiting = waiting;
  cb_state_timer = timer;
  cb_state_settings = settings;
  cb_state_daemon_now = daemon_now;
  /* Recomputed on every successful read rather than once at startup, exactly as
   * fetchPomodoro does: this is what makes the item's countdown agree with every open tab
   * regardless of how far this machine's wall clock has drifted. `before` rather than a
   * fresh reading, so the round trip's own duration lands in the offset as latency rather
   * than as skew. */
  cb_state_offset = daemon_now - before;
  cb_state_answered_at = cb_now_ms();
  cb_state_answered_once = 1;
  cb_state_zero_fetched = 0;
  [cb_state_lock unlock];
}

/* The one derivation both readers share: the once-a-second repaint, and the popover's
 * buttons, which need to know what the primary control currently means. Lock, copy,
 * unlock, derive — nothing is derived while the lock is held, and nothing that can block
 * happens inside it.
 *
 * Returns 0 when the daemon has never answered, which is criterion 9's first half: there
 * is nothing to draw and no item to draw it on. `zero_fetched_out` is the boundary
 * re-fetch's debounce and is wanted by exactly one caller; NULL for the other. */
static int cb_current_display(cb_display *out, int *zero_fetched_out) {
  [cb_state_lock lock];
  cb_timer timer = cb_state_timer;
  cb_settings settings = cb_state_settings;
  double daemon_now = cb_state_daemon_now;
  double offset = cb_state_offset;
  double answered_at = cb_state_answered_at;
  int answered_once = cb_state_answered_once;
  if (zero_fetched_out != NULL) *zero_fetched_out = cb_state_zero_fetched;
  [cb_state_lock unlock];

  if (!answered_once) return 0;

  double local_now = cb_now_ms();
  int answered = (local_now - answered_at) <= CB_STALE_AFTER_MS;
  /* The one line of staleness policy that is not inside cb_derive: a daemon that has gone
   * quiet leaves the arc frozen at the last answer rather than draining against a document
   * nothing is refreshing. */
  double now_ms = answered ? local_now + offset : daemon_now;
  *out = cb_derive(answered, &timer, &settings, now_ms);
  return 1;
}

/* Every POST this file makes, in the one shape they all take: onto the poll queue (never
 * the main thread — cb_request blocks), then a fresh poll behind it.
 *
 * That trailing poll is not decoration. The queue is serial, so it runs strictly after
 * the POST it follows, and it is what makes the item reflect a press within a tick rather
 * than up to CB_POLL_S later — the widget on the index page has exactly the same
 * arrangement (postPomodoro applies the response it got), and criterion 4 is stated
 * relative to that widget. */
static void cb_dispatch_action(cb_action action) {
  if (cb_poll_queue == nil) return;
  dispatch_async(cb_poll_queue, ^{
    cb_perform(action);
    cb_poll_once();
  });
}

/* --- The drawing ----------------------------------------------------------------------
 *
 * The widget's own geometry, redrawn in AppKit rather than parsed out of the SVG:
 * src/pomodoro-widget.mjs's TOMATO_ICON and REST_ICON are a 24-unit viewBox with a shared
 * `circle cx=12 cy=14.6 r=6.8`, stroke-width 2, round caps and joins; the tomato adds a
 * stem and two leaves above it, the bars glyph replaces those with two vertical strokes
 * inside it. Every number below is lifted from those two strings.
 *
 * SVG's y grows downward and AppKit's grows up, so each y is mirrored through
 * `CB_SVG_Y(y)` once, here, and every coordinate after that is ordinary y-up AppKit. That
 * is one conversion in one place instead of a flipped CTM whose sign then has to be
 * carried into the arc's direction as well. */
#define CB_SVG_Y(y) (24.0 - (y))

static const double CB_CIRCLE_X = 12.0;
static const double CB_CIRCLE_Y = 9.4;   /* CB_SVG_Y(14.6) */
static const double CB_CIRCLE_R = 6.8;
static const double CB_STROKE = 2.0;

/* The item's image, in points. 18 tall is the most a 22pt menu bar takes without crowding
 * it; the width is trimmed to what the glyph actually needs so the countdown text sits
 * beside the icon rather than across a gap. CB_SCALE maps the 24-unit box into that
 * height: the ink spans y 4.6..21.4 in SVG units plus half a stroke either side, i.e.
 * 18.8 units, and 0.82 leaves a hair of margin inside 18pt. CB_INK_CENTER_Y is where that
 * ink is centred (y-up), and it is the TOMATO's centre for both glyphs on purpose — the
 * bars glyph is shorter, and centring each one on its own ink would make the icon jump
 * half a point up the menu bar every time a work interval became a break. */
static const double CB_ICON_W = 15.0;
static const double CB_ICON_H = 18.0;
static const double CB_SCALE = 0.82;
static const double CB_INK_CENTER_Y = 11.0;

/* This icon carries NO COLOUR AT ALL, and that is the whole of how it is right in light,
 * in dark, while the menu bar is highlighted, under Increase Contrast and under Reduce
 * Transparency. A template image is an ALPHA MASK: AppKit throws the RGB away and tints
 * whatever is left with the menu bar's own current ink, which is a colour the system
 * recomputes for every one of those conditions and which nothing here could compute
 * correctly by hand. A hand-resolved colour — even one resolved per draw against the
 * right appearance — is a fixed grey the moment the system's own ink is not the grey you
 * picked, and that is exactly how it looked.
 *
 * So there is no amber for work here, and no labelColor/secondaryLabelColor either. The
 * four states are told apart by SHAPE and WEIGHT alone (ADR 80), which is what they were
 * chosen for in the first place: the thing that distinguishes the breaks is weight rather
 * than colour, so it survives Increase Contrast, and it would survive being made a
 * template image later. It has been.
 *
 * Alpha is the one channel that survives templating, because alpha IS the mask, so the
 * two weight distinctions the widget already draws are spelled in it:
 *
 *   - idle and paused at CB_ALPHA_MUTED — the widget's "turned down" weight, a tomato
 *     that has nothing to count reading as off rather than as broken.
 *   - a daemon that has gone quiet at CB_ALPHA_STALE, one step further down again. This
 *     is criterion 9's "dims rather than disappearing", and it is a mask value rather
 *     than a colour precisely so the system still owns the hue underneath it.
 *   - the long break's disc at CB_ALPHA_FILL of whatever the ink is. This one is the
 *     tuned number: it is now the ONLY thing separating a short break from a long one, so
 *     it has to read unmistakably as filled at a ~12pt circle, while still leaving the
 *     arc and the two bars legible at full weight on top of it. 0.4 is a clear half tone
 *     against a 1.0 stroke; 0.28 was tried first and disappeared into the menu bar. */
static const CGFloat CB_ALPHA_FULL = 1.0;
static const CGFloat CB_ALPHA_MUTED = 0.62;
static const CGFloat CB_ALPHA_STALE = 0.35;
static const CGFloat CB_ALPHA_FILL = 0.4;

/* Black is arbitrary and unused: only the alpha reaches the screen. Spelled explicitly
 * rather than as `[NSColor blackColor]` so nobody later "fixes" it to a semantic colour
 * on the belief that it is doing something. */
static NSColor *cb_mask(CGFloat alpha) {
  return [NSColor colorWithWhite:0.0 alpha:alpha];
}

static CGFloat cb_ink_alpha(cb_display d) {
  if (!d.answered) return CB_ALPHA_STALE;
  if (d.muted) return CB_ALPHA_MUTED;
  return CB_ALPHA_FULL;
}

static NSBezierPath *cb_path(void) {
  NSBezierPath *path = [NSBezierPath bezierPath];
  path.lineWidth = CB_STROKE;
  path.lineCapStyle = NSLineCapStyleRound;
  path.lineJoinStyle = NSLineJoinStyleRound;
  return path;
}

static void cb_line(NSBezierPath *path, double x1, double y1, double x2, double y2) {
  [path moveToPoint:NSMakePoint(x1, CB_SVG_Y(y1))];
  [path lineToPoint:NSMakePoint(x2, CB_SVG_Y(y2))];
}

/* Draws into whatever context is current, in the 24-unit space the widget's SVG uses.
 * Called only from the drawing handler below, which has already established the transform.
 * Every `set` here is a mask value, never a colour — see cb_mask above. */
static void cb_draw(cb_display d) {
  CGFloat alpha = cb_ink_alpha(d);

  /* The long break's circle is filled rather than outlined — the one thing that tells the
   * two breaks apart, and it is WEIGHT rather than hue on purpose, which is what lets the
   * whole icon be a template image. */
  if (d.filled) {
    NSRect disc = NSMakeRect(CB_CIRCLE_X - CB_CIRCLE_R, CB_CIRCLE_Y - CB_CIRCLE_R,
                             CB_CIRCLE_R * 2.0, CB_CIRCLE_R * 2.0);
    [cb_mask(alpha * CB_ALPHA_FILL) setFill];
    [[NSBezierPath bezierPathWithOvalInRect:disc] fill];
  }

  [cb_mask(alpha) setStroke];

  /* Criterion 3: the circle the glyphs already share IS the progress indicator. There is
   * no track drawn behind it — the arc simply gets shorter, which is what makes "how much
   * is left" readable at a glance with the digits switched off. Twelve o'clock is 90
   * degrees in a y-up space, and the sweep runs clockwise from there, the direction every
   * dial in the world runs. Idle is the one state that draws the whole circle instead:
   * a glyph with no interval behind it should look like the widget's plain tomato, not
   * like an interval that just ran out. */
  NSBezierPath *circle = cb_path();
  if (!d.arc) {
    [circle appendBezierPathWithOvalInRect:NSMakeRect(CB_CIRCLE_X - CB_CIRCLE_R,
                                                      CB_CIRCLE_Y - CB_CIRCLE_R,
                                                      CB_CIRCLE_R * 2.0, CB_CIRCLE_R * 2.0)];
  } else if (d.fraction > 0.0) {
    [circle appendBezierPathWithArcWithCenter:NSMakePoint(CB_CIRCLE_X, CB_CIRCLE_Y)
                                       radius:CB_CIRCLE_R
                                   startAngle:90.0
                                     endAngle:90.0 - 360.0 * d.fraction
                                    clockwise:YES];
  }
  [circle stroke];

  NSBezierPath *marks = cb_path();
  if (d.phase == CB_BREAK || d.phase == CB_LONG_BREAK) {
    /* REST_ICON's `M10 11v7.2M14 11v7.2` — two bars, not one. src/styles.mjs already made
     * that call for the tab mark: a single rest stroke at this size reads as a rendering
     * failure, two read as deliberate. */
    cb_line(marks, 10.0, 11.0, 10.0, 18.2);
    cb_line(marks, 14.0, 11.0, 14.0, 18.2);
  } else {
    /* TOMATO_ICON's `M12 7.8V4.6` stem and its two leaves. */
    cb_line(marks, 12.0, 7.8, 12.0, 4.6);
    cb_line(marks, 12.0, 7.8, 8.2, 5.9);
    cb_line(marks, 12.0, 7.8, 15.8, 5.9);
  }
  [marks stroke];
}

/* A fresh image per tick — the arc and the digits need one anyway — marked as a template
 * on the way out.
 *
 * `template = YES` is the entire appearance story of this file, and it is one line
 * because the platform is doing the work: AppKit takes the alpha channel, discards the
 * rest, and fills it with whatever ink the menu bar is using at the moment it composites.
 * That is not an approximation of light and dark, it IS light and dark, plus the
 * highlighted state while a menu is open, plus Increase Contrast, plus Reduce
 * Transparency, plus whatever the next macOS decides a menu bar looks like — and this
 * process is told about none of it and needs to be told about none of it.
 *
 * A status item's button is composited by ControlCenter rather than by us (QUIRKS.md),
 * which is also why hand-resolving a colour against this process's own appearance was
 * never going to land on the right one. */
static NSImage *cb_image(cb_display d) {
  NSImage *image = [NSImage imageWithSize:NSMakeSize(CB_ICON_W, CB_ICON_H)
                                  flipped:NO
                           drawingHandler:^BOOL(NSRect rect) {
                             (void)rect;
                             NSAffineTransform *fit = [NSAffineTransform transform];
                             [fit translateXBy:CB_ICON_W / 2.0 yBy:CB_ICON_H / 2.0];
                             [fit scaleBy:CB_SCALE];
                             [fit translateXBy:-CB_CIRCLE_X yBy:-CB_INK_CENTER_Y];
                             [fit concat];
                             cb_draw(d);
                             return YES;
                           }];
  image.template = YES;
  return image;
}

/* --- The popover ----------------------------------------------------------------------
 *
 * An NSPopover rather than an NSMenu, and it is worth being honest about what that buys
 * and what it costs. It buys two things a menu cannot have: the countdown keeps ticking
 * while the reader is looking straight at it (which is why the tick lives in
 * NSRunLoopCommonModes — QUIRKS.md measured that a main-queue block never runs while a
 * status item is tracking, and that trap is exactly this one), and the primary control is
 * a real button rather than a menu row pretending to be one. It costs roughly double the
 * line count, and it makes light and dark, Reduce Transparency, Increase Contrast, focus
 * rings and full keyboard access this repo's problem rather than NSMenu's.
 *
 * The whole strategy against that bill is: DO NOT STYLE ANYTHING. Every control here is a
 * stock AppKit one at its default appearance, the popover keeps its own material and
 * background, and the only colour named in the whole section is `secondaryLabelColor` —
 * a SEMANTIC name the system resolves per appearance, not a value. An NSButton nobody
 * touched is already right
 * in every appearance and every accessibility setting, has a focus ring, is reachable
 * under Full Keyboard Access and reports itself to VoiceOver; a hand-drawn row is none of
 * those, for each of which this file would then own a bug. It is the same call the
 * template image made after the first build resolved its own colours and read as flat
 * grey.
 *
 * The layout, top to bottom, and the exact words:
 *
 *     Work · 12:34                     (one line, retitled every tick)
 *     [ Pause ] [ Forward ] [ Restart ]
 *     ─────────────────────────────
 *     3 waiting for an answer          (caption, carrying the count; "Nothing waiting" at zero)
 *     [ claude-board · round 2 ]       (at most five, newest board first)
 *     [ 3 more waiting ]               (only when there are more; opens the index)
 *     ─────────────────────────────
 *     [ Settings… ]
 *     [ Hide from menu bar ]
 *
 * Criterion 8 is enforced by CB_ACTION_PATHS above rather than by this layout: there is no
 * Reset row here because there is no reset route reachable from this file at all.
 * Criterion 7 is the Settings… row, which opens the index page on its existing panel — no
 * setting is editable here, and the one thing that writes anything (Hide) is a command
 * with one outcome rather than a form. */

/* Wide enough for the waiting caption plus a comfortable row, narrow enough that the
 * popover reads as an accessory rather than a window. The row labels are elided to
 * CB_TITLE_MAX above rather than being allowed to widen this. */
static const CGFloat CB_POPOVER_W = 264.0;

@interface CBPopover : NSObject
@property(nonatomic, strong) NSPopover *popover;
/* Retitled by the tick while the popover is open, which is the whole reason this is a
 * popover: `NSTextField` for the phase line, and the primary button whose meaning changes
 * the instant the daemon's state does. */
@property(nonatomic, strong) NSTextField *statusLine;
@property(nonatomic, strong) NSButton *primary;
/* Parallel to the row buttons' `tag`s. An NSString rather than an NSURL because the
 * validator that decides whether it may be opened is a C function taking a C string. */
@property(nonatomic, strong) NSArray<NSString *> *rowURLs;
@end

/* A stock push button, titled and labelled. `accessibility` is a full sentence where the
 * title is a word: a screen reader reads the button on its own, without the line above it
 * that gives a bare "Pause" its subject. Nothing here sets a colour, a font, a bezel or a
 * background — see the section comment. */
static NSButton *cb_button(NSString *title, NSString *accessibility, id target, SEL action, NSInteger tag) {
  NSButton *button = [NSButton buttonWithTitle:title target:target action:action];
  button.tag = tag;
  [button setAccessibilityLabel:accessibility];
  return button;
}

/* A row that names a thing rather than an action gets its title on the left, because a
 * centred board title reads as a label and truncates from the middle. That is alignment,
 * not styling: the bezel, the ink and the focus ring are still the system's. */
static NSButton *cb_row_button(NSString *title, NSString *accessibility, id target, SEL action, NSInteger tag) {
  NSButton *button = cb_button(title, accessibility, target, action, tag);
  button.alignment = NSTextAlignmentLeft;
  return button;
}

static NSTextField *cb_caption(NSString *text, BOOL secondary) {
  NSTextField *label = [NSTextField labelWithString:text];
  /* The one appearance decision in the whole popover, and it is a SEMANTIC colour rather
   * than a value: `secondaryLabelColor` is what the system means by "this is a caption",
   * and it resolves itself in light, in dark and under Increase Contrast. */
  if (secondary) label.textColor = [NSColor secondaryLabelColor];
  return label;
}

/* The index page, and the fragment ticket 02 wired to open the pomodoro panel explicitly.
 * Built from this process's own port rather than from anything on the wire — unlike a
 * board URL, which is always the one `GET /api/waiting` handed over (that route builds it
 * from the request's own Host, so there is exactly one place in the product that knows
 * how to spell a board URL and it is not here). */
static NSURL *cb_index_url(NSString *fragment) {
  return [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%d/%@", cb_port(), fragment]];
}

/* The default browser opens it, and the browser's own long-lived session authorizes the
 * page (ADR 57) — no credential travels in the URL, and a browser holding none lands on
 * the refusal page src/render.mjs already renders, naming the recovery command. Exactly
 * bin/notify.m's shape for the same errand. */
static void cb_open_url(NSURL *url) {
  if (url == nil) return;
  [[NSWorkspace sharedWorkspace] openURL:url
                           configuration:[NSWorkspaceOpenConfiguration configuration]
                       completionHandler:^(NSRunningApplication *app, NSError *error) {
                         (void)app;
                         if (error != nil) {
                           fprintf(stderr, "claude-board: could not open %s: %s\n",
                                   [[url absoluteString] UTF8String],
                                   [[error localizedDescription] UTF8String]);
                         }
                       }];
}

@implementation CBPopover

/* Criterion 5, and it is a rule about the GESTURE rather than a feature: one click, one
 * outcome, always. There is no shortcut where a waiting board makes the click open that
 * board, and no state in which the click toggles the timer instead — a menu bar item
 * whose click means two different things depending on what the daemon happens to be doing
 * is one nobody can press without looking first.
 *
 * A second click on an open popover closes it — or, if the transient behaviour below has
 * already dismissed it by the time this action arrives (the mouse-down lands outside the
 * popover, which is what dismisses it), reopens it. Both outcomes are the criterion:
 * whatever the state, the gesture leaves a popover on screen or takes the one you were
 * looking at away, and never does something else entirely. */
- (void)toggle:(id)sender {
  if (![sender isKindOfClass:[NSStatusBarButton class]]) return;
  NSStatusBarButton *button = (NSStatusBarButton *)sender;
  if (self.popover.shown) {
    [self.popover performClose:nil];
    return;
  }
  [self rebuild];
  /* Without an active app the popover's window cannot become key, and a popover that
   * cannot become key cannot be driven from the keyboard at all — which would make every
   * row below mouse-only. `activateWithOptions:` rather than
   * -[NSApplication activateIgnoringOtherApps:], which is deprecated as of macOS 14 and
   * would fail the build's own warning-free check, and rather than -[NSApplication
   * activate], which does not exist before it. */
  [[NSRunningApplication currentApplication] activateWithOptions:NSApplicationActivateAllWindows];
  [self.popover showRelativeToRect:button.bounds ofView:button preferredEdge:NSRectEdgeMinY];
  /* The primary control takes focus, so Tab walks the rows from the top and Space presses
   * whatever it reached. Escape closes a transient popover with no help from here. */
  [self.popover.contentViewController.view.window makeFirstResponder:self.primary];
  /* And a fresh poll behind the open, so the rows the NEXT open draws are current even if
   * this one caught the list a moment before a round was answered. */
  if (cb_poll_queue != nil) dispatch_async(cb_poll_queue, ^{ cb_poll_once(); });
}

/* Rebuilt from scratch on every open rather than mutated in place: the row set changes
 * between opens and nothing about a popover that is not on screen is worth keeping.
 *
 * ponytail: the rows are a snapshot taken when the popover opened, and they do NOT
 * re-lay-out while it is open — only the phase line and the primary button retitle on the
 * tick. The ceiling is a round answered in another window while the popover is open,
 * which leaves a row that opens an already-answered board (a page, not an error) until
 * the popover is reopened. The upgrade path is to rebuild from the tick when the list's
 * contents change, and the reason not to is that rows moving under a moving cursor is a
 * misclick that opens the wrong board — NSMenu does not do it either. */
- (void)rebuild {
  /* An unanswered daemon derives to the same zeroes cb_derive would produce for one, so
   * the popover opens saying so rather than not opening. It cannot happen today —
   * cb_ensure_item runs only after the first answer — and costs one line to not depend on
   * that staying true. */
  cb_display display;
  if (!cb_current_display(&display, NULL)) memset(&display, 0, sizeof(display));

  [cb_state_lock lock];
  cb_waiting waiting = cb_state_waiting;
  [cb_state_lock unlock];

  NSMutableArray<NSView *> *rows = [NSMutableArray array];
  NSMutableArray<NSString *> *urls = [NSMutableArray array];

  char status[64];
  cb_status_label(display, status, sizeof(status));
  self.statusLine = cb_caption([NSString stringWithUTF8String:status], NO);
  [rows addObject:self.statusLine];

  cb_action switch_action = cb_switch_action(display);
  /* The widget's own aria-label spelling ("Start pomodoro" / "Pause pomodoro" / "Resume
   * pomodoro"), so the two surfaces say the same sentence to a screen reader even though
   * the visible titles differ in length. */
  NSString *switch_word = [NSString stringWithUTF8String:cb_switch_label(switch_action)];
  self.primary = cb_button(switch_word, [switch_word stringByAppendingString:@" pomodoro"],
                           self, @selector(pressPrimary:), 0);
  NSButton *forward = cb_button(@"Forward", @"Forward to the next interval", self,
                                @selector(pressForward:), 0);
  NSButton *restart = cb_button(@"Restart", @"Restart this interval", self,
                                @selector(pressRestart:), 0);
  NSStackView *controls = [NSStackView stackViewWithViews:@[ self.primary, forward, restart ]];
  controls.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  controls.distribution = NSStackViewDistributionFillEqually;
  controls.spacing = 6.0;
  [rows addObject:controls];

  [rows addObject:[self separator]];

  char waiting_caption[48];
  cb_waiting_caption(waiting.count + waiting.more, waiting_caption, sizeof(waiting_caption));
  [rows addObject:cb_caption(@(waiting_caption), YES)];
  for (int i = 0; i < waiting.count; i++) {
    NSString *label = [NSString stringWithUTF8String:waiting.rows[i].label];
    if (label == nil) continue;
    NSString *url = [NSString stringWithUTF8String:waiting.rows[i].url];
    if (url == nil) continue;
    [rows addObject:cb_row_button(label, [@"Open " stringByAppendingString:label], self,
                                  @selector(pressRow:), (NSInteger)urls.count)];
    [urls addObject:url];
  }
  if (waiting.more > 0) {
    NSString *more = [NSString stringWithUTF8String:waiting.more_label];
    [rows addObject:cb_row_button(more != nil ? more : @"More waiting",
                                  @"Open the index page, which lists every board waiting for an answer",
                                  self, @selector(pressIndex:), 0)];
  }
  self.rowURLs = urls;

  [rows addObject:[self separator]];
  [rows addObject:cb_row_button(@"Settings…", @"Open the pomodoro settings on the index page",
                                self, @selector(pressSettings:), 0)];
  [rows addObject:cb_row_button(@"Hide from menu bar",
                                @"Hide the status item; the index page's pomodoro settings bring it back",
                                self, @selector(pressHide:), 0)];

  NSStackView *stack = [NSStackView stackViewWithViews:rows];
  stack.orientation = NSUserInterfaceLayoutOrientationVertical;
  /* Every row the same width as the stack, which is what makes the list read as a list
   * rather than as a column of differently-sized buttons. */
  stack.alignment = NSLayoutAttributeWidth;
  stack.spacing = 6.0;
  stack.edgeInsets = NSEdgeInsetsMake(12.0, 14.0, 12.0, 14.0);
  stack.translatesAutoresizingMaskIntoConstraints = NO;

  NSView *content = [[NSView alloc] initWithFrame:NSMakeRect(0.0, 0.0, CB_POPOVER_W, 10.0)];
  [content addSubview:stack];
  /* Auto Layout decides the height from what the stack holds, so a popover with five
   * waiting rows is taller than one with none and neither has a hardcoded number behind
   * it. The width is the one fixed dimension. */
  [NSLayoutConstraint activateConstraints:@[
    [stack.leadingAnchor constraintEqualToAnchor:content.leadingAnchor],
    [stack.trailingAnchor constraintEqualToAnchor:content.trailingAnchor],
    [stack.topAnchor constraintEqualToAnchor:content.topAnchor],
    [stack.bottomAnchor constraintEqualToAnchor:content.bottomAnchor],
    [content.widthAnchor constraintEqualToConstant:CB_POPOVER_W],
  ]];

  NSViewController *controller = [[NSViewController alloc] init];
  controller.view = content;

  if (self.popover == nil) {
    self.popover = [[NSPopover alloc] init];
    /* Transient: clicking anywhere else, or pressing Escape, closes it. The alternative
     * (semi-transient) leaves a popover on screen after the reader has moved on, which for
     * a status item is a window they did not ask to keep.
     *
     * No `appearance` is set, and the material and background are left alone — see the
     * section comment. */
    self.popover.behavior = NSPopoverBehaviorTransient;
  }
  self.popover.contentViewController = controller;
}

- (NSBox *)separator {
  NSBox *box = [[NSBox alloc] initWithFrame:NSZeroRect];
  box.boxType = NSBoxSeparator;
  return box;
}

/* The tick's half of the popover: two strings, and nothing else. Called once a second
 * from cb_tick — including while the popover is TRACKING, which is the property the tick's
 * NSRunLoopCommonModes registration exists to buy. Rebuilding rows here is deliberately
 * not done; see -rebuild. */
- (void)refresh:(cb_display)display {
  if (!self.popover.shown) return;
  char status[64];
  cb_status_label(display, status, sizeof(status));
  NSString *line = [NSString stringWithUTF8String:status];
  if (line != nil) self.statusLine.stringValue = line;
  NSString *word = [NSString stringWithUTF8String:cb_switch_label(cb_switch_action(display))];
  if (word != nil && ![self.primary.title isEqualToString:word]) {
    self.primary.title = word;
    [self.primary setAccessibilityLabel:[word stringByAppendingString:@" pomodoro"]];
  }
}

/* Derived at the moment of the press rather than read off the button's own title: the
 * title is at most one tick old, and "at most one second stale" is not a thing to be about
 * a control that starts or stops a timer. Mirrors src/indexpage.mjs's own
 * `postPomodoro(pomodoroSwitchAction(pomodoroDoc.timer))`, which reads its cached document
 * for the same reason rather than its own button's label. */
- (void)pressPrimary:(id)sender {
  (void)sender;
  cb_display display;
  cb_action action = CB_ACTION_START;
  if (cb_current_display(&display, NULL)) action = cb_switch_action(display);
  cb_dispatch_action(action);
}

- (void)pressForward:(id)sender {
  (void)sender;
  cb_dispatch_action(CB_ACTION_FORWARD);
}

- (void)pressRestart:(id)sender {
  (void)sender;
  cb_dispatch_action(CB_ACTION_RESTART);
}

/* Criterion 12. The popover closes first — a popover hanging off an item that is about to
 * leave the menu bar has nothing to hang from — and then the POST goes out. Nothing is
 * torn down and no state is persisted here: the setting is the daemon's, every poll reads
 * it back, and this process stays alive and hidden precisely so the index page's own
 * settings panel has something to bring back. */
- (void)pressHide:(id)sender {
  (void)sender;
  [self.popover performClose:nil];
  cb_dispatch_action(CB_ACTION_HIDE);
}

- (void)pressRow:(id)sender {
  if (![sender isKindOfClass:[NSButton class]]) return;
  NSInteger index = [(NSButton *)sender tag];
  if (index < 0 || index >= (NSInteger)self.rowURLs.count) return;
  NSString *url = self.rowURLs[(NSUInteger)index];
  /* Checked AGAIN here, having already been checked when the row was built. This is the
   * trust boundary — the call below hands a URL to LaunchServices, which will act on any
   * scheme it can resolve — and a check at the boundary costs a string scan and survives
   * whatever a future edit does to how the row got here. */
  if (!cb_is_board_url([url UTF8String], cb_port())) return;
  [self.popover performClose:nil];
  cb_open_url([NSURL URLWithString:url]);
}

- (void)pressIndex:(id)sender {
  (void)sender;
  [self.popover performClose:nil];
  cb_open_url(cb_index_url(@""));
}

/* Criterion 7, and the whole of this file's settings story: the index page's existing
 * panel, opened on the fragment ticket 02 wired up for exactly this. Nothing is editable
 * from the menu bar — re-implementing four duration fields, two notify toggles and three
 * cue pickers (the last of which is read by scanning the system sounds at call time)
 * natively is the most expensive part of this feature and buys a panel opened once a
 * month. */
- (void)pressSettings:(id)sender {
  (void)sender;
  [self.popover performClose:nil];
  cb_open_url(cb_index_url(@"#pomodoro-settings"));
}

@end

/* --- The item -------------------------------------------------------------------------
 *
 * Created lazily, and that laziness is the whole of criterion 9's first half: there is no
 * item at all until the daemon has answered once. That is also the whole handling of the
 * boot race and of install.sh's bootout → bootstrap → kickstart, with no state to persist
 * — launchd starts this child and the daemon at the same moment, and an item that drew
 * "idle" for the two seconds before the daemon bound its port would be lying about the
 * interval a reader is actually in.
 *
 * Becoming an NSApplication is deferred to the same moment, and that is NOT tidiness.
 * Measured: a process that calls +[NSApplication sharedApplication] from inside an app
 * bundle is registered with LaunchServices by macOS on the spot — no window, no status
 * item, no daemon answer needed. LaunchServices records are permanent and share a bundle
 * id (QUIRKS.md measured 6908 of them, and a stale one naming a deleted path is the
 * "claude-board.app is damaged and can't be opened" dialog arriving weeks later). The
 * real install wants that record and install.sh creates it deliberately; what must never
 * create one is a THROWAWAY bundle, and test/check-install.mjs stages and runs one of
 * those on every suite run. Deferring makes that impossible by construction rather than by
 * a cleanup step a future check could forget: the check's launcher is run against a port
 * that is already bound, so its daemon exits without ever answering, so this child never
 * becomes an app and never registers anything.
 *
 * It is also simply the honest shape. A `--menubar` child that can never reach a daemon —
 * a degraded install, a daemon that failed to bind — has nothing to draw and no business
 * holding a window server connection for the length of a login session. */
static NSStatusItem *cb_item = nil;

/* Strong, and file-scope for the same reason bin/notify.m's delegate is: an NSStatusItem's
 * `button.target` is a WEAK reference, so a controller kept only by the button would be
 * deallocated the moment cb_ensure_item returned and every click would arrive at nothing.
 * It lives as long as the item does, which is as long as the login session. */
static CBPopover *cb_popover = nil;

static void cb_ensure_item(void) {
  if (cb_item != nil) return;

  /* Accessory, matching bin/notify.m's click-serving mode. The return value is NOT
   * checked, and that is deliberate: the BOOL means "did the policy change", not "did this
   * succeed", so it comes back NO whenever the policy already matches. QUIRKS.md measured
   * that the status item is visible with this call omitted entirely, under today's
   * LSBackgroundOnly plist, from a shell and from launchd alike — nothing rests on it, and
   * Info.plist is not touched by this feature for the same reason a rebuild is not free (a
   * changed plist is a changed bundle is a re-prompt for the Documents grant). */
  [NSApplication sharedApplication];
  (void)[NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  [NSApp finishLaunching];

  cb_item = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
  cb_item.button.imagePosition = NSImageLeft;
  /* Monospaced DIGITS at the menu bar's own point size — not a monospaced font, which
   * would look like a terminal escaped into the menu bar, and not the system default
   * size, which is a point smaller than everything beside it. Proportional digits are a
   * visible wobble at a one-second tick: `1` is narrower than `8` in the system font, so
   * the item's width changes as the numerals do and every item to its left shuffles once
   * a second, all day.
   *
   * No colour is set on the button at all, deliberately: an unstyled `title` is drawn in
   * whatever ink the menu bar is using, which is the same reason cb_image above marks its
   * image as a template. Reaching for `attributedTitle` to colour it would be reaching
   * back for the problem the template image just solved. */
  cb_item.button.font = [NSFont monospacedDigitSystemFontOfSize:[NSFont menuBarFontOfSize:0.0].pointSize
                                                         weight:NSFontWeightRegular];
  cb_item.button.toolTip = @"claude-board";
  /* Criterion 5's one gesture, wired once: every click on the item goes here and nowhere
   * else, whatever is waiting and whatever the Timer is doing. */
  cb_popover = [[CBPopover alloc] init];
  cb_item.button.target = cb_popover;
  cb_item.button.action = @selector(toggle:);
  /* One line per login session, on stdout (the daemon's out log, not its err log): the
   * AppKit half of this feature has no automated check by design, so the one fact worth
   * leaving behind for a human verifying it is the moment the item came into existence. */
  printf("claude-board: menu bar item created\n");
  fflush(stdout);
}

/* The once-a-second repaint. Reads the cached document and the clock offset, derives, and
 * draws — it decides nothing and fetches nothing, exactly like renderPomodoro on the index
 * page. Runs on the main thread, from a timer installed in NSRunLoopCommonModes, which is
 * what keeps it running while the popover tracks. */
static void cb_tick(void) {
  cb_display d;
  int zero_fetched = 0;
  /* criterion 9: no item exists yet, and none is made here */
  if (!cb_current_display(&d, &zero_fetched)) return;

  cb_ensure_item();
  /* menubarHidden: the item still exists, it is just not on the bar. Never an exit —
   * ticket 05's "bring it back from the index page" has to work with no restart, and a
   * process that exited when hidden would leave nothing for the setting to reach. */
  cb_item.visible = d.hidden ? NO : YES;
  cb_item.button.image = cb_image(d);
  cb_item.button.title = d.countdown ? [NSString stringWithUTF8String:d.text] : @"";
  /* The popover's own second, if it is open. Two strings and no layout — see -refresh:. */
  [cb_popover refresh:d];

  /* The boundary re-fetch, and it is not optional: criterion 1 pins this item to within a
   * second of the index widget, and the widget re-fetches the moment its own countdown
   * reaches zero (tickPomodoro). Without this, an interval that ended would sit at 00:00
   * with an empty arc for up to CB_POLL_S while the widget had already moved on. Debounced
   * to one fetch per crossing, the poll being the backstop if that one is lost.
   *
   * `d.phase != CB_IDLE` is cb_derive's spelling of "there is a timer": the protocol has
   * no idle phase, so a running timer always derives to one of the other three. */
  if (d.answered && d.phase != CB_IDLE && !d.paused && d.remaining_s <= 0 && !zero_fetched) {
    [cb_state_lock lock];
    cb_state_zero_fetched = 1;
    [cb_state_lock unlock];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ cb_poll_once(); });
  }
}

/* --- Entry points ---------------------------------------------------------------------
 *
 * Declared `extern int cb_menubar(void)` and
 * `extern int cb_menubar_probe(const char *word, const char *argument)` in bin/launcher.c
 * rather than in a header, on the same footing as cb_notify: one caller each, one
 * definition each, all compiled together by the one build in install.sh, and signatures
 * short enough to check against their definitions by eye. Both return 0 on a clean
 * finish, which is what keeps a `bootout` from looking like a crash in the log. */
int cb_menubar(void) {
  install_stop_handlers();

  @autoreleasepool {
    /* No AppKit call at all until the daemon has answered — cb_ensure_item above owns the
     * whole of becoming an application, and its comment says why. Nothing before this
     * point touches the window server or LaunchServices. */
    cb_state_lock = [[NSLock alloc] init];
    cb_defaults(&cb_state_timer, &cb_state_settings);

    /* The fetch runs on its own serial queue, never on the main thread. Two reasons, and
     * either alone would be enough: a synchronous loopback GET on the main thread would
     * stall the repaint for as long as the daemon took to answer, and a main-queue timer
     * does not fire at all while a status item's menu or popover is tracking (QUIRKS.md,
     * measured) — which would silently stop the poll for as long as the reader kept
     * ticket 05's popover open. DISPATCH_TIME_NOW as the start, so the first fetch goes
     * out immediately and the item can appear as soon as the daemon is up; a one-second
     * leeway, because nothing here needs the wakeup to be punctual.
     *
     * The popover's actions go out on this SAME queue (cb_dispatch_action), which is why
     * it is file-scope and why it is serial: a POST and the poll that reads its effect
     * back must not race, and serial makes "post, then re-read" an ordering rather than a
     * hope. */
    cb_poll_queue =
        dispatch_queue_create("io.github.jerrylui.claude-board.menubar.poll", DISPATCH_QUEUE_SERIAL);
    dispatch_source_t poll = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, cb_poll_queue);
    dispatch_source_set_timer(poll, DISPATCH_TIME_NOW, (uint64_t)(CB_POLL_S * (double)NSEC_PER_SEC),
                              (uint64_t)NSEC_PER_SEC);
    dispatch_source_set_event_handler(poll, ^{ cb_poll_once(); });
    dispatch_resume(poll);

    /* NSRunLoopCommonModes, not the default mode, and this is the trap QUIRKS.md wrote
     * down after measuring it: menu and popover tracking run the loop in
     * NSEventTrackingRunLoopMode, which a default-mode timer never reaches. A countdown
     * that froze the moment ticket 05's popover opened — the one moment a reader is
     * looking straight at it — would be the most visible bug this file could ship. */
    NSTimer *tick = [NSTimer timerWithTimeInterval:CB_TICK_S
                                           repeats:YES
                                             block:^(NSTimer *timer) {
                                               (void)timer;
                                               cb_tick();
                                             }];
    [[NSRunLoop mainRunLoop] addTimer:tick forMode:NSRunLoopCommonModes];

    /* A Mach port added as an input source and never sent anything. Without it this is not
     * a wait but a spin: -[NSRunLoop runMode:beforeDate:] returns NO *immediately* when the
     * loop has no source or timer attached, so a bare loop around it burns a core until the
     * signal arrives. The timer above makes it redundant today, and it is cheaper to leave
     * in place than to make the loop's correctness depend on whichever AppKit object
     * happens to be installed at the time. */
    [[NSRunLoop currentRunLoop] addPort:[NSPort port] forMode:NSDefaultRunLoopMode];

    /* A hand-rolled -[NSApplication run], rather than the real one, for exactly one
     * property: `stop_requested` is still tested every quarter second. `[NSApp run]` owns
     * the loop and leaves it only for -stop:, which needs a signal handler that can safely
     * reach AppKit and a dummy event posted after it; polling a sig_atomic_t is the whole
     * of what a handler may do, and this shape needs nothing more. The events matter as
     * much as the wait does — a bare NSRunLoop would service the timers above but never
     * DISPATCH an event, so the item would draw and ticket 05's clicks would go nowhere.
     * A quarter second is far inside launchd's exit timeout and invisible to a reader; the
     * pool is INSIDE the loop, because one pool wrapping a loop that runs for the length of
     * a login session is a leak that grows all day.
     *
     * Two shapes, because this process is not an application until the daemon has answered
     * (cb_ensure_item). Before that NSApp is nil, and a message to nil comes straight back
     * — so pumping events there would not be a wait at all but the same 100% spin the port
     * above exists to prevent. The plain run loop is the correct wait in that state and
     * services the poll and the tick perfectly well; there is simply nothing yet that could
     * generate an event.
     *
     * ponytail: a stop that arrives while a menu or popover is TRACKING is noticed when
     * tracking ends, not immediately — tracking runs its own nested loop and never returns
     * here. The ceiling is a logout with the popover open costing the SIGKILL after
     * launchd's two seconds; the upgrade path is a second thread that _exit(0)s on the
     * flag, which is a thread to own for a case that costs one log line. */
    while (!stop_requested) {
      @autoreleasepool {
        NSDate *until = [NSDate dateWithTimeIntervalSinceNow:0.25];
        if (NSApp == nil) {
          [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:until];
          continue;
        }
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
                                            untilDate:until
                                               inMode:NSDefaultRunLoopMode
                                              dequeue:YES];
        if (event != nil) [NSApp sendEvent:event];
      }
    }

    dispatch_source_cancel(poll);
    [tick invalidate];
  }
  return 0;
}

/* The probe's action vocabulary: one word from argv, matched against this closed table,
 * and the only thing that crosses out of it is a cb_action — an index into
 * CB_ACTION_PATHS, never a byte of argv. Exactly the shape bin/launcher.c's MESSAGES
 * lookup takes for the notify phase, and for the same reason: this binary carries the
 * reader's Documents grant, so "argv can be nothing but an index" is the goal.
 *
 * `reset` IS NOT HERE, and its absence is criterion 8 (see CB_ACTION_PATHS). The word is
 * refused like any other unrecognised one, which is what lets a check assert the refusal
 * behaviourally as well as by reading this file. */
static const struct { const char *word; cb_action action; } CB_PROBE_ACTIONS[] = {
  { "start", CB_ACTION_START },
  { "pause", CB_ACTION_PAUSE },
  { "resume", CB_ACTION_RESUME },
  { "forward", CB_ACTION_FORWARD },
  { "restart", CB_ACTION_RESTART },
  { "hide", CB_ACTION_HIDE },
};

/* A TEST SEAM, and nothing else. `claude-board --menubar --probe` performs exactly one
 * fetch, prints what the item and its popover would show, and exits — no NSApplication,
 * no status item, no popover, no run loop, nothing on screen. Becoming an application is
 * what registers a bundle with LaunchServices (see cb_ensure_item), and the check suite
 * runs this against throwaway bundles, so this path must never reach AppKit.
 *
 * It exists because the AppKit half cannot be checked at all: there is no headless way to
 * assert a status item's title, or a popover's contents. So the interesting half is kept
 * OUT of AppKit — cb_derive, cb_row_label, cb_overflow_count, cb_status_label and
 * cb_switch_action are all pure C — and this mode is how a node check reaches them,
 * against a real daemon on a temp home, the way test/check-launcher-menubar.mjs already
 * compiles and drives this binary. It also gets the "daemon absent" and "wrong secret"
 * cases for free: both come back `answered=no`, which is the honest report and not a
 * crash.
 *
 * Gated on a second argv word so the supervised path cannot reach it: bin/launcher.c execs
 * this binary with exactly `--menubar` and nothing after it.
 *
 * Two optional words follow, and they are the seam's two shapes:
 *
 *   <action>            one of CB_PROBE_ACTIONS, POSTed before the report. This is what
 *                       makes criterion 4 checkable at all: a check can start, pause,
 *                       resume, forward and restart the daemon's real timer through the
 *                       same cb_perform the popover's buttons call, and read the daemon's
 *                       own state back afterwards. An unrecognised word — the reset
 *                       action most of all — is refused with a nonzero exit and posts
 *                       nothing.
 *   url <candidate>     print whether cb_is_board_url would let a row open that URL, and
 *                       exit. The one way to check criterion 6's refusal without a daemon
 *                       that can be made to emit a bad URL.
 *
 * Output. The first line is space-separated `key=value` with every value a bare word, so a
 * check can split it without a parser; `text` is the countdown the derivation produced
 * whether or not it would be shown (`countdown` is the flag that says whether it reaches
 * the button) and is the word `none` when there is no interval to count. The lines after
 * it carry the popover's own words, one per line, `key=` and then the rest of the line
 * verbatim — because a row label contains spaces and a middle dot, and quoting them would
 * be a parser this seam does not need. Exits 0 even when the daemon never answered: the
 * errand was to report, and it reported. */
int cb_menubar_probe(const char *word, const char *argument) {
  @autoreleasepool {
    if (word != NULL && strcmp(word, "url") == 0) {
      /* The validator, alone, against one candidate — no request, no daemon, no state. */
      int ok = argument != NULL && cb_is_board_url(argument, cb_port());
      printf("url=%s\n", ok ? "ok" : "refused");
      fflush(stdout);
      return 0;
    }
    if (word != NULL) {
      int matched = 0;
      for (size_t i = 0; i < sizeof(CB_PROBE_ACTIONS) / sizeof(CB_PROBE_ACTIONS[0]); i++) {
        if (strcmp(word, CB_PROBE_ACTIONS[i].word) != 0) continue;
        /* Synchronously, on this thread: there is no run loop here and nothing else to
         * do, and the report below has to describe the state AFTER the action landed. */
        if (!cb_perform(CB_PROBE_ACTIONS[i].action)) {
          fprintf(stderr, "claude-board: the daemon did not accept %s\n", word);
          return 1;
        }
        matched = 1;
        break;
      }
      if (!matched) {
        fprintf(stderr, "claude-board: unrecognised menu bar action\n");
        return 2;
      }
    }

    cb_timer timer;
    cb_settings settings;
    double daemon_now = 0.0;
    int answered = cb_fetch(&timer, &settings, &daemon_now) ? 1 : 0;
    cb_display d = cb_derive(answered, &timer, &settings, daemon_now);

    static const char *const PHASES[] = { "idle", "work", "break", "longBreak" };
    printf("phase=%s paused=%s remaining=%ld fraction=%.3f countdown=%s text=%s hidden=%s "
           "answered=%s primary=%s\n",
           PHASES[d.phase], d.paused ? "yes" : "no", d.remaining_s, d.fraction,
           d.countdown ? "yes" : "no", d.text[0] ? d.text : "none", d.hidden ? "yes" : "no",
           d.answered ? "yes" : "no", cb_switch_label(cb_switch_action(d)));

    char status[64];
    cb_status_label(d, status, sizeof(status));
    printf("status=%s\n", status);

    cb_waiting waiting;
    memset(&waiting, 0, sizeof(waiting));
    (void)cb_fetch_waiting(&waiting);
    printf("waiting=%d total=%d more=%d\n", waiting.count, waiting.total, waiting.more);
    for (int i = 0; i < waiting.count; i++) printf("row=%s\n", waiting.rows[i].label);
    if (waiting.more > 0) printf("morerow=%s\n", waiting.more_label);
    /* The caption carries the count (see cb_waiting_caption), so it is a thing a check
       has to be able to read -- printed unconditionally, including at zero. */
    char caption[48];
    cb_waiting_caption(waiting.count + waiting.more, caption, sizeof(caption));
    printf("caption=%s\n", caption);
    fflush(stdout);
  }
  return 0;
}
