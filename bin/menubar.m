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
 * how much of the ring is left, whether digits show. It owns NO clock, NO settings and NO
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
#include <stdlib.h>
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

/* bin/launcher.c's tab surfacer, declared here on the same footing and for the same
 * reason (ADR 93). A waiting row and a banner open the same board URLs, so "is this board
 * already open somewhere" gets ONE answer in this product rather than one per surface:
 * given a URL that has already passed cb_is_board_url, it returns 1 when it raised an
 * already-open tab and this file must therefore open nothing. Every other outcome -- no
 * scriptable browser running, no tab on this board, no osascript, a script that failed or
 * outran its budget -- is 0 and the plain open below, which is entry 57's behaviour
 * unchanged. Only a BOARD is surfaced this way: the index page and the settings panel are
 * plain opens (see -pressIndex: and -pressSettings:), a decision entry 93 is deliberately
 * silent about because the index is not a board a reviewer is sitting on. */
extern int cb_surface_tab(const char *board_url);

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

/* `--menubar --probe stream` (bottom of this file) has no poll of its own to bound it: it
 * holds `GET /api/events` open and waits for whichever push a caller triggers. Five seconds
 * is generous next to a loopback round trip and short enough that a genuinely broken
 * stream still fails the check that uses it in a few seconds, not never. Overridden by the
 * probe's own second argument, in whichever check needs a different number. */
static const double CB_STREAM_DEFAULT_TIMEOUT_S = 5.0;

/* Ticket 02's LIVE stream connection's own idle timeout — not the probe above, which is
 * bounded some other way, but the long-lived `GET /api/events` subscription the real run
 * loop holds open beside its poll. `NSURLRequest.timeoutInterval` measures IDLE time, reset
 * by every byte the daemon sends, so as long as the daemon's own heartbeat (every
 * `DEFAULT_SSE_HEARTBEAT_MS`, 15s by default) keeps landing this figure is never reached in
 * the healthy case. Set well clear of that cadence — several heartbeats' worth of margin —
 * rather than left at NSURLRequest's own 60s default, so an operator who lengthened the
 * daemon's heartbeat with `CLAUDE_BOARD_SSE_HEARTBEAT_MS` does not silently outrun a number
 * this file never named. What happens when it IS reached — the connection erroring out — is
 * handled the same way every other drop is: CBEventStream's `didCompleteWithError:` below
 * schedules a reconnect on the backoff the next two constants name. */
static const double CB_STREAM_IDLE_TIMEOUT_S = 120.0;

/* Ticket 03: how long to wait before trying `GET /api/events` again after the connection
 * above ends, for ANY reason — a drop, a daemon that was never there, a non-200 answer
 * running out its own short body, the idle timeout just above. Doubled after every failed
 * attempt and reset the instant one succeeds (CBEventStream's own `didReceiveResponse:`),
 * the same shape a browser's own EventSource reconnect uses and for the same reason: a
 * daemon genuinely down for a while should not be hammered once a second for the length of
 * a login session, and a daemon merely mid-restart (install.sh's usual few hundred
 * milliseconds) should not sit unnoticed anywhere near the cap either. */
static const double CB_STREAM_RECONNECT_INITIAL_S = 1.0;
static const double CB_STREAM_RECONNECT_MAX_S = 30.0;

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
 * a remaining time into the ring's fraction; the two booleans are the item's own
 * preferences, edited on the index page and read here. `long_every` is ADR 88's own
 * addition — settings.longEvery, the divisor pomodoroCyclePosition (src/indexpage.mjs)
 * clamps the popover's cycle position against, mirrored rather than invented. */
typedef struct {
  double work_ms;
  double break_ms;
  double long_break_ms;
  int countdown;    /* settings.menubarCountdown */
  int hidden;       /* settings.menubarHidden */
  int long_every;   /* settings.longEvery */
} cb_settings;

/* What sits in the middle of the silhouette, and only one thing ever can. The rest bar and
 * the paused bars are mutually exclusive by construction rather than by two booleans that
 * could both be set: a paused break draws the paused bars and nothing else. */
typedef enum {
  CB_MARK_NONE = 0,   /* idle, and a running work interval */
  CB_MARK_REST,       /* a running break, short or long alike */
  CB_MARK_PAUSED,     /* paused, in every phase */
} cb_mark;

/* What the item looks like. Deliberately flat and copyable: it crosses into a drawing
 * block by value, which is what keeps the renderer from reaching back for anything the
 * derivation did not decide for it.
 *
 * `ring` and `mark` are the whole of the glyph decision, and they are FIELDS rather than
 * conditions the drawing code rediscovers from `phase` and `paused` for one reason: the
 * drawing cannot be checked and these can. test/check-menubar-client.mjs reads them off
 * `--menubar --probe` and asserts the vocabulary state by state without a window server. */
typedef struct {
  int answered;       /* has the daemon answered inside CB_STALE_AFTER_MS */
  int hidden;         /* settings.menubarHidden — the item exists but is not visible */
  cb_phase phase;
  int paused;
  int ring;           /* draw the progress ring inside the outline */
  cb_mark mark;       /* what is drawn in the centre, if anything */
  double fraction;    /* 0..1 of the interval still to run — the ring's sweep */
  long remaining_s;   /* rounded the way formatCountdown rounds */
  int countdown;      /* would the digits be on screen */
  char text[16];      /* "MM:SS", or "" when there is no interval to count */
  /* ADR 88: the popover's own line mirrors pomodoroCyclePosition (src/indexpage.mjs),
   * which is null for anything but a running work-or-break interval — a long break
   * carries no position, having just reset the count the position is measured against.
   * `has_position` is that null check made a field, for the same reason `ring`/`mark`
   * above are fields and not a condition cb_status_label would otherwise rediscover. */
  int has_position;
  int position_num;    /* cycle + 1, clamped at long_every */
  int position_denom;  /* settings.longEvery, floored at 1 against a non-positive value --
                         * never clamped against position_num the way the numerator is */
} cb_display;

/* Every wire number that is about to become a fixed-width integer, or to be rounded into
 * one, is clamped here first.
 *
 * `pomodoro.json` is hand-editable by design and `normalizeDoc` (src/pomodoro.mjs) only
 * guarantees the arithmetic on the DAEMON's side cannot produce NaN — a `cycle` of `1e300`
 * is an integer as far as `Number.isInteger` is concerned, so it survives every validator
 * on the way here and arrives intact. Converting a double that large to `int` is undefined
 * behaviour in C, not a wraparound with a defined answer: the reported result was a
 * NEGATIVE cycle position in the popover, and a compiler is entitled to do anything at all
 * with it. Clamping first is the whole fix, and it costs a compare.
 *
 * NaN clamps to `lo` (there is no meaningful answer, and `lo` is the quiet one); either
 * infinity falls out of the ordinary comparisons at the right end. */
static double cb_clamp(double value, double lo, double hi) {
  if (isnan(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/* The bound the counted wire fields are held to. Far past anything the product can produce
 * — a hundred thousand pomodoros is a lifetime, and `longEvery`'s own validator
 * (src/pomodoro.mjs) refuses anything over 100 at the HTTP boundary — so nothing
 * legitimate is ever clamped. It exists so `cycle + 1` cannot overflow and so the popover's
 * `%d/%d` cannot print a negative. */
#define CB_COUNT_MAX 100000

/* A remaining time that could not be a real interval. `deadline` is a wire value too, so
 * `deadline - now` is as unbounded as the document is, and `llround` of anything past
 * LONG_MAX is undefined the same way the casts above are. A hundred days is many orders of
 * magnitude past MAX_DURATION_MIN (one day, src/pomodoro.mjs) and still nowhere near the
 * edge. The same bound covers a phase LENGTH, which is the ring's denominator: a NaN there
 * would print `nan` as the fraction, past every clamp on the fraction itself. */
static const double CB_MAX_REMAINING_MS = 100.0 * 24.0 * 60.0 * 60.0 * 1000.0;

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
 * own `now` when it passes it — so a daemon that went quiet leaves the ring stopped where
 * it was rather than draining to empty against a document nothing is refreshing. That
 * one line of policy is the caller's; everything else about staleness is here: the digits
 * go, the shape stays.
 *
 * ONE SIGNAL, ONE DIMENSION (ADR 84), and not one of them is a colour. The tomato
 * silhouette is drawn in every state, so it says nothing and never has to; what varies is
 * two fields and no more. `ring` is time remaining, and it is the only thing that carries
 * it — during work, the one interval whose remaining time the glyph reports at all.
 * `mark` is the phase-or-paused mark in the centre, and it is the only thing that carries
 * that. Alpha is left to say one thing alone — the daemon has stopped answering — which is
 * why idle and paused derive at full weight here and are told apart by shape.
 *
 * So: idle is the silhouette alone; running work is the silhouette and the ring; a running
 * break is the silhouette and the rest bar, SHORT AND LONG ALIKE and with no ring on either
 * (the long break's filled disc is retired — the two breaks have no dimension left to spend
 * on being told apart, and the popover says which one in words); and paused, in every
 * phase, is the silhouette and the two bars, also with no ring. A paused Timer therefore no
 * longer says which phase it is paused in, which is accepted: it has nothing to be late
 * for. The ring's own reasons for being work-only are at the assignment below. */
static cb_display cb_derive(int answered, const cb_timer *timer, const cb_settings *settings,
                            double now_ms, int cycle) {
  cb_display d;
  memset(&d, 0, sizeof(d));
  d.answered = answered ? 1 : 0;
  d.hidden = settings->hidden ? 1 : 0;
  /* A full sweep, so a state that draws no ring never leaves a stale fraction behind for
   * one that does. */
  d.fraction = 1.0;

  if (!timer->running) {
    /* Idle: the silhouette alone, no ring and no centre mark, and no countdown at all —
     * countdown text appears only while a timer exists, so an idle item is the icon alone
     * whatever menubarCountdown says: a duration that is not counting down would read as
     * one that is. The index page's widget used to say "Idle (25 min)" and now says the
     * bare "Idle" this line has always said, on the same reasoning — so the popover and
     * the widget agree here as they do in every running state. */
    d.phase = CB_IDLE;
    return d;
  }

  d.phase = timer->phase;
  d.paused = timer->paused ? 1 : 0;
  /* The ring is WORK'S, and a running work interval's. Two states give it up and for two
   * different reasons:
   *
   *   - PAUSED, because a stopped ring and a running one differ only by not moving, which a
   *     glance at a menu bar cannot see. Two bars can be seen.
   *   - a BREAK, short and long alike, because the ring is not legible enough to be worth
   *     the ink there. CB_RING_R + CB_RING_STROKE/2 lands 0.15 units inside the outline's
   *     own inner edge — at CB_SCALE that is about a tenth of a point, so a break drew the
   *     outline, a near-touching second arc AND the rest bar, and the whole glyph read as a
   *     thickened tomato rather than as three marks. It was the densest thing in the menu
   *     bar during the one interval nobody is meant to be watching it.
   *
   * A break's remaining time is not lost: the digits beside the glyph still count it down
   * for anyone who wants the number, and the popover says the phase in words. What the
   * glyph says now is the thing a break actually needs to say — not working — and the ring
   * becomes a second reading of the phase rather than only of the clock: ring means work.
   *
   * It also lands the two surfaces on the same picture. src/pomodoro-widget.mjs's REST_ICON
   * is the silhouette plus the one bar and has never had a ring in it; the break glyph here
   * is now that same drawing rather than that drawing plus an arc. */
  d.ring = (!d.paused && timer->phase == CB_WORK) ? 1 : 0;
  if (d.paused) d.mark = CB_MARK_PAUSED;
  else if (timer->phase == CB_BREAK || timer->phase == CB_LONG_BREAK) d.mark = CB_MARK_REST;
  else d.mark = CB_MARK_NONE;

  /* pomodoroCyclePosition (src/indexpage.mjs), rewritten in C rather than a second
   * opinion: null (here, `has_position = 0`) for anything but work or break, and
   * `cycle + 1` clamped at `long_every` otherwise — the ordinal of whichever interval is
   * currently running, out of the configured cycle length. See that function's own
   * comment for why the clamp is not a guess. */
  if (timer->phase == CB_WORK || timer->phase == CB_BREAK) {
    int every = settings->long_every > 0 ? settings->long_every : 1;
    int position = cycle + 1;
    if (position > every) position = every;
    d.has_position = 1;
    d.position_num = position;
    d.position_denom = every;
  }

  /* Clamped at BOTH ends, not just at zero: `deadline`/`remainingMs` are wire values and a
   * hand-edited one can be arbitrarily large, which `llround` below has no defined answer
   * for (cb_clamp's own comment). */
  double remaining = cb_clamp(timer->paused ? timer->remaining_ms : timer->deadline_ms - now_ms,
                              0.0, CB_MAX_REMAINING_MS);

  /* The ring is remaining-over-configured, not remaining-over-elapsed: the denominator is
   * the phase's CURRENT setting, which is the same number restartTimer mints a deadline
   * from. A reader who shortens the work interval mid-interval therefore sees a ring that
   * is already past where it would have been, which is honest — the interval they are in
   * is longer than the one they just configured, and the digits say so too.
   *
   * Derived in every running state, including the ones that draw no ring — a break, and a
   * pause: it is what the ring comes back to when work resumes, and the probe reports it
   * either way, which is what lets a check pin the sweep without a window server. */
  double total = cb_clamp(cb_phase_length_ms(timer->phase, settings), 0.0, CB_MAX_REMAINING_MS);
  d.fraction = total > 0.0 ? remaining / total : 0.0;
  if (d.fraction > 1.0) d.fraction = 1.0;
  if (d.fraction < 0.0) d.fraction = 0.0;

  /* llround, matching formatCountdown's own Math.round: the two surfaces have to agree on
   * which second they are showing, and floor-vs-round is a whole second of disagreement
   * for half of every second. */
  d.remaining_s = (long)llround(remaining / 1000.0);
  snprintf(d.text, sizeof(d.text), "%02ld:%02ld", d.remaining_s / 60, d.remaining_s % 60);

  /* Whether the digits reach the button, and there are three ways for the answer to be no.
   * The text is derived either way above — this flag alone decides, so the setting costs a
   * redraw and never a restart.
   *
   *   - the reader turned menubarCountdown off, which leaves the icon and removes the text.
   *   - the daemon has gone quiet: digits from a document nothing is refreshing are the one
   *     part of the picture that would be actively wrong rather than merely stale.
   *   - the Timer is PAUSED (ADR 83). A frozen countdown reads as a clock that has stopped
   *     working rather than one deliberately stopped, and it says a second time what the
   *     two bars in the glyph already say. The menu bar title is empty while paused; the
   *     index page's dial keeps its number, having room for it. */
  d.countdown = (settings->countdown && answered && !d.paused) ? 1 : 0;
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

/* The popover's one line of text about the Timer — ADR 88, narrowing ADR 83. This is now
 * renderPomodoro's own line (src/indexpage.mjs), rewritten in C rather than a second
 * opinion: the phase, the cycle position where one applies, the countdown, and
 * "(paused)" while paused. Idle is the one shape kept apart, exactly as the index page
 * keeps a bare "Idle" line apart from a running one: there is no interval to count and no
 * position to state.
 *
 * The phase word itself is not this file's to choose (ADR 88: the popover's line is "the
 * index page's own string in every state", and the spec that ADR answers is explicit that
 * the popover moves toward the widget, never the reverse) — it is
 * pomodoroPhaseLabel's own three-way split (src/indexpage.mjs), mirrored rather than
 * invented: "Break" and "Long break" for the two break phases, never the wire's
 * `break`/`longBreak`, and never a fourth phase name for paused, because paused is a state
 * of a phase and not a phase — the same distinction cb_derive keeps.
 *
 * What ADR 83 said and no longer says: that a paused Timer drops to the phase name alone,
 * with no time and no "paused" word, because a frozen countdown reads as a broken clock.
 * ADR 88 disagrees for THIS line only — a reader with the index page open in another
 * window already sees that same frozen countdown and the word "paused" beside it, so a
 * popover that said less was a second, poorer answer about the same timer, not a kinder
 * one. What ADR 83 still owns: the menu bar TITLE (the digits beside the icon, suppressed
 * by cb_derive's own `countdown` field) stays empty while paused, and the glyph keeps its
 * paused shape — both untouched here, and both criteria 7 and 8's "do not break". */
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
  const char *phase = d.phase == CB_WORK ? "Work" : (d.phase == CB_BREAK ? "Break" : "Long break");
  const char *paused_suffix = d.paused ? " (paused)" : "";
  if (d.has_position) {
    snprintf(out, out_len, "%s %d/%d · %s%s", phase, d.position_num, d.position_denom, d.text,
             paused_suffix);
  } else {
    snprintf(out, out_len, "%s · %s%s", phase, d.text, paused_suffix);
  }
}

/* --- What the buttons do --------------------------------------------------------------
 *
 * Five actions, and the table below is the whole vocabulary: every POST this process can
 * make is one of these five route literals, chosen by an enum value, never by a string
 * anything outside this file supplied. All five drive the Timer and nothing else — this
 * process writes no setting at all, which is a stronger form of "no setting is editable
 * from the menu bar" than a rule about which rows exist. The sixth entry that used to sit
 * here posted `menubarHidden` for a "Hide from menu bar" row that no longer exists: hiding
 * the item is reachable only from the index page's own pomodoro settings, because a row
 * that removes the surface you would use to undo it is a one-way door.
 *
 * RESET IS NOT HERE, AND ITS ABSENCE IS THE FEATURE. Reset ends the whole loop and zeroes
 * the cycle; the index widget already made the call to bury it inside the settings panel,
 * and a popover is not the place to hand that a second front door — a menu bar item is
 * clicked by accident in a way a collapsed settings panel is not. Forward and Restart
 * stay, because neither destroys anything: forward advances the boundary the daemon was
 * going to cross anyway, restart re-mints the interval that is already running. If a
 * future reader adds a sixth row here, `/api/pomodoro/reset` is still the one route that
 * must not appear in this array, and test/check-menubar-client.mjs asserts exactly that
 * against this file's own bytes. */
typedef enum {
  CB_ACTION_START = 0,
  CB_ACTION_PAUSE,
  CB_ACTION_RESUME,
  CB_ACTION_FORWARD,
  CB_ACTION_RESTART,
} cb_action;

static const char *const CB_ACTION_PATHS[] = {
  "/api/pomodoro/ensure",
  "/api/pomodoro/pause",
  "/api/pomodoro/resume",
  "/api/pomodoro/forward",
  "/api/pomodoro/restart",
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

/* One word, where the widget's aria-label says "Start pomodoro". This names the ACTION a
 * press performs, and it is what the switch reports to a screen reader — in the widget's
 * full spelling (see the popover below), since a screen reader reads a control without the
 * line above it. It is NOT what the reader sees beside the switch; that is the word below,
 * and the two are different words on purpose. */
static const char *cb_switch_label(cb_action action) {
  if (action == CB_ACTION_START) return "Start";
  if (action == CB_ACTION_RESUME) return "Resume";
  return "Pause";
}

/* The switch's position, and the index page widget's own rule rewritten in C rather than a
 * second opinion: on exactly when a timer is running unpaused, so idle and paused both read
 * as off and both turn back on — one 'ensure', the other 'resume'. */
static BOOL cb_switch_on(cb_display d) {
  return d.phase != CB_IDLE && !d.paused;
}

/* The word beside the switch, which is the state the switch is IN — where cb_switch_label
 * above is the action a press performs. A switch needs both: "Pause" on a control that is
 * currently running is an instruction, not a report, and a control whose only word is an
 * instruction leaves the reader working out the state from the knob alone.
 *
 * This is the one place in the whole popover that says "paused", which is the other half
 * of why cb_status_label drops the word (ADR 83): said in two rows it is a fact stated
 * twice, and here it sits against the control that undoes it.
 *
 * "Off" rather than "Idle" while there is no timer: the status line beside it already says
 * Idle, and a switch that is off says off. */
static const char *cb_switch_state_word(cb_display d) {
  if (d.phase == CB_IDLE) return "Off";
  return d.paused ? "Paused" : "Running";
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

/* `cb_cached_secret` above is read and written from more than one GCD queue at once: the
 * poll queue (every `cb_request` call) and CBEventStream's own private delegate queue
 * (`didCompleteWithError:`'s `cb_forget_secret()`, on the SSE session's own queue — NOT
 * `cb_poll_queue` — since a reconnect ATTEMPT is what `cb_stream_schedule_reconnect`
 * serializes onto the poll queue, not the drop notification that precedes it) are two
 * independent serial queues that never rendezvous with each other. An unguarded `static`
 * object pointer is not safe against that: an assignment retains the new value and
 * releases the old one, and two threads racing the same assignment can double-release a
 * value the other thread still holds, which is a crash in the one process holding the
 * reader's TCC identity. `cb_secret_lock` below is created exactly once, however many
 * threads reach for it first, and every read and write of `cb_cached_secret` happens
 * inside it — never the blocking file read itself, which stays outside the lock so a slow
 * disk cannot stall an unrelated queue's own access to the cache. */
static NSLock *cb_secret_lock(void) {
  static NSLock *lock = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    lock = [[NSLock alloc] init];
  });
  return lock;
}

static NSString *cb_secret(void) {
  [cb_secret_lock() lock];
  NSString *cached = cb_cached_secret;
  [cb_secret_lock() unlock];
  if (cached != nil) return cached;

  NSString *file = cb_secret_path();
  if (file == nil) return nil;
  NSString *raw = [NSString stringWithContentsOfFile:file encoding:NSUTF8StringEncoding error:NULL];
  NSString *trimmed =
      [raw stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  NSString *value = trimmed.length > 0 ? trimmed : nil;

  [cb_secret_lock() lock];
  cb_cached_secret = value;
  [cb_secret_lock() unlock];
  return value;
}

static void cb_forget_secret(void) {
  [cb_secret_lock() lock];
  cb_cached_secret = nil;
  [cb_secret_lock() unlock];
}

static int cb_port(void) {
  NSString *value = [[[NSProcessInfo processInfo] environment] objectForKey:@"CLAUDE_BOARD_PORT"];
  int port = value != nil ? [value intValue] : 0;
  return (port > 0 && port <= 65535) ? port : CB_DEFAULT_PORT;
}

static double cb_now_ms(void) { return [[NSDate date] timeIntervalSince1970] * 1000.0; }

/* DEFAULT_SETTINGS (src/pomodoro.mjs), duplicated here for exactly one purpose: a probe
 * or a tick that has no answer yet still derives a well-formed display rather than one
 * built on zeroes, where a zero denominator would make every ring empty. Nothing on the
 * ordinary path ever draws these — the item is not created until a real response has
 * replaced them (criterion 9). */
static void cb_defaults(cb_timer *timer, cb_settings *settings) {
  memset(timer, 0, sizeof(*timer));
  settings->work_ms = 25.0 * 60000.0;
  settings->break_ms = 5.0 * 60000.0;
  settings->long_break_ms = 15.0 * 60000.0;
  settings->countdown = 1;
  settings->hidden = 0;
  settings->long_every = 4;
}

/* The protocol's three phase spellings and nothing else. An unrecognised one — a future
 * daemon that grew a fourth phase talking to an install that predates it — is reported as
 * "no timer", which draws the calm idle glyph rather than a ring against a length this
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

/* Every wire number that is about to become a fixed-width integer goes through here as
 * well as through cb_clamp — see cb_clamp's own comment for why any of this exists. */
static int cb_number_int(NSDictionary *dict, NSString *key, double fallback, int lo, int hi) {
  return (int)cb_clamp(cb_number(dict, key, fallback), (double)lo, (double)hi);
}

static int cb_bool(NSDictionary *dict, NSString *key, int fallback) {
  id value = dict[key];
  return [value isKindOfClass:[NSNumber class]] ? ([value boolValue] ? 1 : 0) : fallback;
}

/* `cb_request`'s own delegate, whose entire job is refusing every HTTP redirect outright.
 * `[NSURLSession sharedSession]` — what this function used before — has no delegate at
 * all, and NSURLSession auto-follows a redirect when nothing tells it not to: a `302
 * Location:` pointing off this machine would silently carry the `x-claude-board-secret`
 * header above wherever it named, laundered through this signed, TCC-granted process.
 * Refusing EVERY redirect, not just an off-origin one — a loopback client never has a
 * request that is correctly redirected, so there is no case where following one is right,
 * and telling off-origin apart from same-origin would be machinery kept alive for a
 * distinction this client has no use for. Returning `nil` to the completion handler is the
 * refusal: NSURLSession then hands the redirect response itself back as the final answer,
 * exactly as if this process had never heard of redirects at all. */
@interface CBNoRedirectDelegate : NSObject <NSURLSessionTaskDelegate>
@end

@implementation CBNoRedirectDelegate
- (void)URLSession:(NSURLSession *)session
                          task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response
                    newRequest:(NSURLRequest *)request
             completionHandler:(void (^)(NSURLRequest *))completionHandler {
  (void)session;
  (void)task;
  (void)response;
  (void)request;
  completionHandler(nil);
}
@end

/* Created once and reused for the rest of the process's life — a fresh NSURLSession per
 * call would be pure churn against a delegate that never needs to change. `cb_request`
 * below is reachable from more than one queue at once (the timer-driven poll on
 * `cb_poll_queue`, and — via `cb_poll_once` — the zero-crossing re-fetch dispatched on the
 * global concurrent queue, which this file does not own and does not fix here), so a plain
 * lazily-assigned static is exactly the S5 bug again: two threads racing past a `== nil`
 * check both assign, and ARC releases the loser's session while it is still in use.
 * `dispatch_once`, the same idiom `cb_secret_lock()` above uses, creates it exactly once
 * however many threads reach for it first, and needs no lock on the read path after
 * that. */
static NSURLSession *cb_request_session(void) {
  static NSURLSession *session = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    session = [NSURLSession sessionWithConfiguration:[NSURLSessionConfiguration defaultSessionConfiguration]
                                             delegate:[[CBNoRedirectDelegate alloc] init]
                                        delegateQueue:nil];
  });
  return session;
}

/* One request, synchronously, and — until `cb_stream_probe` below, ticket 01's test seam
 * only — the only place in this file that speaks HTTP. NEVER call this on the main thread
 * while the item is up: it blocks, and the whole point of the poll queue below is that the
 * network half cannot be starved by — or starve — a menu or popover tracking on the main
 * run loop. That applies to the popover's own actions as much as to the poll: every one of
 * them hops onto the poll queue first, precisely because a reader who pressed Pause while
 * the daemon was wedged would otherwise be holding a frozen popover open. The one caller
 * that does run it on the main thread is `--menubar --probe`, which has no run loop, no
 * item and nothing else to do.
 *
 * `body` non-nil makes it a POST with a JSON content-type; nil is a bodyless request of
 * whatever `method` says. Returns the response body on a 200 and nil on anything else —
 * a refusal, a 404, a timeout and a daemon that is not there are all the same answer to
 * every caller here, which is "no", and none of them has a second thing to do about it.
 *
 * `path` is ALWAYS a compiled-in literal — /api/pomodoro, /api/waiting, or one of
 * CB_ACTION_PATHS above. Nothing this process reads over the network or takes from argv
 * ever reaches it, which is why building the URL by format string here is safe.
 *
 * Deliberately NOT what `cb_stream_probe` below is built on: this function returns only
 * once the daemon ENDS the response, and an SSE stream never does. */
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
  NSURLSessionDataTask *task = [cb_request_session()
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

/* --- The stream probe -------------------------------------------------------------------
 *
 * `--menubar --probe stream` (bottom of this file), and nothing else: no ordinary poll or
 * popover action ever opens `GET /api/events`. It exists to check the daemon-wide stream is
 * real -- reachable over real loopback, by a real `NSURLSession`, holding a real connection
 * open -- ahead of anything in this file having a use for what arrives: this process still
 * only polls today, and nothing below reads what this probe mode observes. Widening this
 * seam rather than opening a second one is deliberate: `test/check-menubar-client.mjs`
 * already drives every other claim in this file through `--probe`, and a stream-only test
 * double would prove that double works, not this binary.
 *
 * `cb_request` above cannot serve this: it returns only once the daemon ENDS the response,
 * and an SSE stream never does. This reads the body incrementally instead, through an
 * `NSURLSessionDataDelegate` -- which needs no run loop of its own to call back on, same as
 * `cb_request`'s completion handler above: `NSURLSession` runs its delegate queue
 * regardless of whether the calling thread is spinning one, so a plain
 * `dispatch_semaphore_wait` is enough to block this synchronous probe on it. */
@interface CBStreamProbe : NSObject <NSURLSessionDataDelegate>
@property (nonatomic, strong) NSMutableData *buffer;
@property (nonatomic) NSInteger statusCode;
@property (nonatomic, strong) dispatch_semaphore_t headersSem;
@property (nonatomic, strong) dispatch_semaphore_t eventSem;
@property (nonatomic, copy) NSString *eventName;
@property (nonatomic) BOOL delivered;
@end

@implementation CBStreamProbe

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _buffer = [NSMutableData data];
    _headersSem = dispatch_semaphore_create(0);
    _eventSem = dispatch_semaphore_create(0);
  }
  return self;
}

/* Signals as soon as the daemon's own response headers land -- which is BEFORE
 * `handleStream` (src/server.mjs) can have done anything else, since `res.writeHead` runs
 * before that function's `stream.subscribe(res)` call and both run synchronously with no
 * await between them. So by the time this callback fires, the subscription already exists
 * on the daemon side, and `cb_stream_probe` below is safe to tell its caller to act. */
- (void)URLSession:(NSURLSession *)session
              dataTask:(NSURLSessionDataTask *)task
    didReceiveResponse:(NSURLResponse *)response
     completionHandler:(void (^)(NSURLSessionResponseDisposition disposition))completionHandler {
  self.statusCode = [response isKindOfClass:[NSHTTPURLResponse class]] ? [(NSHTTPURLResponse *)response statusCode] : 0;
  dispatch_semaphore_signal(self.headersSem);
  completionHandler(NSURLSessionResponseAllow);
}

/* Refuses every redirect, the same policy and the same reason `CBNoRedirectDelegate` above
 * carries for `cb_request`'s own session: this probe is a real HTTP client on real
 * loopback, holding the same secret header, and `NSURLSessionDataDelegate` already
 * inherits `NSURLSessionTaskDelegate`, so this method is reachable with no change to the
 * `@interface` above. A refused redirect's response lands in `didReceiveResponse:` above
 * exactly like any other, `statusCode` and all — a redirecting stub is therefore reported
 * the same as any other non-200 answer, never followed. */
- (void)URLSession:(NSURLSession *)session
                          task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response
                    newRequest:(NSURLRequest *)request
             completionHandler:(void (^)(NSURLRequest *))completionHandler {
  (void)session;
  (void)task;
  (void)response;
  (void)request;
  completionHandler(nil);
}

/* Every chunk the stream delivers, appended and re-decoded whole rather than parsed
 * incrementally byte-by-byte: the volumes here are a handful of comment lines and JSON
 * events, never large enough for that to matter. A decode that fails (a multi-byte
 * character split across two chunks -- nothing this stream sends today, but nothing here
 * should assume otherwise) returns nil and this simply waits for the next chunk to
 * complete it, rather than crashing on a byte sequence that is not yet whole.
 *
 * Looks for the first LINE naming an event (`event: <name>`) rather than waiting for a
 * complete `\n\n`-terminated frame: PROTOCOL.md "SSE events" puts the event line before its
 * data line and the closing blank line, so the name is already knowable, and this probe's
 * whole question is "did a push arrive", not "what did it carry". A bare `:` comment line
 * (the leading `: connected`, or a heartbeat) has no `event:` line at all and is silently
 * skipped, same as any real client's parser would. Only the FIRST named event matters --
 * once `delivered` is set, later chunks are ignored, so a caller cannot be handed a stale
 * result by racing this against a second event this same probe is not asking about. */
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
  if (self.delivered) return;
  [self.buffer appendData:data];
  NSString *text = [[NSString alloc] initWithData:self.buffer encoding:NSUTF8StringEncoding];
  if (text == nil) return;
  for (NSString *line in [text componentsSeparatedByString:@"\n"]) {
    if (![line hasPrefix:@"event:"]) continue;
    self.eventName = [[line substringFromIndex:6]
        stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
    self.delivered = YES;
    dispatch_semaphore_signal(self.eventSem);
    return;
  }
}

@end

/* Drives `CBStreamProbe` above end to end: connect, report readiness, wait for a push, report
 * what arrived (or that nothing did), and return -- never throws, never hangs past
 * `timeoutSeconds` plus one ordinary request timeout. Two lines on stdout, flushed
 * separately and in this order:
 *
 *   stream=connected               the daemon answered and the subscription is live; a
 *                                   caller may now trigger whatever change it wants to see
 *   event=<name>  |  event=timeout the first pushed event's name, or a timeout with none
 *
 * `stream=refused` alone (no `event=` line at all) covers everything `cb_request` already
 * folds into one "no" -- a missing secret, a daemon that never answers, a non-200 -- because
 * there was never a live subscription for a caller to have raced against. */
static void cb_stream_probe(double timeoutSeconds) {
  NSString *secret = cb_secret();
  if (secret == nil) {
    printf("stream=refused\n");
    fflush(stdout);
    return;
  }

  // Built the same way `cb_request` builds every other route's URL -- `path` a standalone
  // literal rather than folded into one bigger format string -- so this route is not a
  // second shape the structural closed-set check (test/check-menubar-client.mjs, criterion
  // 8) has to special-case, and so it counts this route the same way it counts every other.
  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%d%s", cb_port(), "/api/events"]];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url
                                                        cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                                    timeoutInterval:timeoutSeconds + CB_REQUEST_TIMEOUT_S];
  [request setValue:secret forHTTPHeaderField:@"x-claude-board-secret"];
  request.HTTPMethod = @"GET";

  CBStreamProbe *delegate = [[CBStreamProbe alloc] init];
  NSURLSession *session = [NSURLSession sessionWithConfiguration:[NSURLSessionConfiguration ephemeralSessionConfiguration]
                                                          delegate:delegate
                                                     delegateQueue:nil];
  NSURLSessionDataTask *task = [session dataTaskWithRequest:request];
  [task resume];

  int64_t headersWaitNs = (int64_t)(CB_REQUEST_TIMEOUT_S * (double)NSEC_PER_SEC);
  BOOL connected = dispatch_semaphore_wait(delegate.headersSem, dispatch_time(DISPATCH_TIME_NOW, headersWaitNs)) == 0
      && delegate.statusCode == 200;
  if (!connected) {
    [task cancel];
    [session invalidateAndCancel];
    cb_forget_secret();
    printf("stream=refused\n");
    fflush(stdout);
    return;
  }
  printf("stream=connected\n");
  fflush(stdout);

  int64_t eventWaitNs = (int64_t)(timeoutSeconds * (double)NSEC_PER_SEC);
  BOOL delivered = dispatch_semaphore_wait(delegate.eventSem, dispatch_time(DISPATCH_TIME_NOW, eventWaitNs)) == 0;
  [task cancel];
  [session invalidateAndCancel];
  if (delivered) {
    printf("event=%s\n", delegate.eventName.UTF8String ?: "");
  } else {
    printf("event=timeout\n");
  }
  fflush(stdout);
}

/* `GET /api/pomodoro`. Fills the outputs with defaults first and returns whether the
 * daemon actually answered, so a caller never has to decide what an unanswered call left
 * behind. `cycle_out` is the document's own top-level `cycle` — a sibling of `timer` and
 * `settings`, never part of either, which is why it is its own out-param rather than a
 * field folded into `cb_settings` or `cb_timer`. */
static BOOL cb_fetch(cb_timer *timer_out, cb_settings *settings_out, double *now_out, int *cycle_out) {
  cb_defaults(timer_out, settings_out);
  *now_out = cb_now_ms();
  *cycle_out = 0;

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
    /* Floored at 1, not at 0: it is a divisor on both sides of the wire (settleBoundary's
     * `breakNumber % longEvery`, and the popover's own position denominator). */
    settings_out->long_every = cb_number_int(settings, @"longEvery", 4.0, 1, CB_COUNT_MAX);
  }

  /* `now` is the daemon's own clock and the only one this file trusts for a deadline. */
  *now_out = cb_number(doc, @"now", *now_out);
  *cycle_out = cb_number_int(doc, @"cycle", 0.0, 0, CB_COUNT_MAX);

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
  built.total = cb_number_int(doc, @"total", (double)waiting.count, 0, CB_COUNT_MAX);

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
    long round = (long)cb_clamp(cb_number(entry, @"round", 0.0), 0.0, (double)CB_COUNT_MAX);
    cb_row_label(title, round, built.rows[built.count].label, sizeof(built.rows[0].label));
    snprintf(built.rows[built.count].url, sizeof(built.rows[0].url), "%s", url);
    built.count++;
  }
  built.more = cb_overflow_count(built.count, built.total);
  cb_overflow_label(built.more, built.more_label, sizeof(built.more_label));
  *out = built;
  return YES;
}

/* One of the five actions, posted, and every one of them is bodyless: src/server.mjs reads
 * no body on those branches at all, which is what makes a native client with nothing to
 * say a first-class caller of them. This process therefore sends no JSON anywhere — it
 * asks the daemon to do one of five things and reads the result back on the next poll.
 *
 * No new API was added for any of this: a native client sends no `Origin` header, which
 * the same-origin gate already treats as same-origin, and the local secret already
 * authorizes every write in the pomodoro set. */
static BOOL cb_perform(cb_action action) {
  NSData *reply = cb_request(@"POST", CB_ACTION_PATHS[action], nil);
  return reply != nil;
}

/* --- The state the two timers share ---------------------------------------------------
 *
 * Written by the poll queue, read by the main thread's tick. A lock rather than a hop
 * onto the main queue, because a main-queue block is exactly what QUIRKS.md measured does
 * not run while a status item's menu or popover is tracking — and the popover is what
 * makes that bite. Nothing here is held across a call that can block. */
static NSLock *cb_state_lock = nil;
static cb_timer cb_state_timer;
static cb_settings cb_state_settings;
static int cb_state_cycle = 0;             /* the document's own top-level `cycle` field */
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

/* Signalled once at the end of every SUCCESSFUL cb_poll_once, and nil everywhere except
 * `--menubar --probe live` (ticket 02's widened seam, bottom of this file) — the real run
 * loop never creates one, so this costs it one pointer compare per poll and nothing else.
 * It is what lets that probe mode say "a push updated the state" without a periodic poll
 * of its own to have found the same answer some other way, and without sleeping and
 * hoping: a semaphore wait either returns because this fired, or it times out. */
static dispatch_semaphore_t cb_poll_completed_sem = nil;

static void cb_poll_once(void) {
  cb_timer timer;
  cb_settings settings;
  double daemon_now = 0.0;
  int cycle = 0;
  double before = cb_now_ms();
  BOOL answered = cb_fetch(&timer, &settings, &daemon_now, &cycle);
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
  cb_state_cycle = cycle;
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

  /* Test seam only — see cb_poll_completed_sem above. */
  if (cb_poll_completed_sem != nil) dispatch_semaphore_signal(cb_poll_completed_sem);
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
  int cycle = cb_state_cycle;
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
   * quiet leaves the ring frozen at the last answer rather than draining against a document
   * nothing is refreshing. */
  double now_ms = answered ? local_now + offset : daemon_now;
  *out = cb_derive(answered, &timer, &settings, now_ms, cycle);
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

/* --- The live stream client ------------------------------------------------------------
 *
 * Ticket 02. Holds `GET /api/events` open for as long as the connection lasts and, on
 * every `pomodoro` or `waiting` push, dispatches a fresh `cb_poll_once` onto the SAME
 * serial queue the periodic poll and every popover action already use — one code path
 * applies state to cb_state_*, whether what triggered it was a timer tick, a button press
 * or a push arriving. `pomodoro`'s own payload mirrors `GET /api/pomodoro` closely enough
 * to parse in place, but re-fetching instead keeps state application confined to the one
 * function that already owns it rather than growing a second parser for the same shape —
 * and it is the ONLY way to answer `waiting`, whose payload is a bare count with no rows
 * in it at all, when what the popover draws is the rows `GET /api/waiting` holds.
 *
 * Deliberately NOT a reconnecting client. Ticket 03 owns retry, staleness and
 * degradation; this file's job stops at "hold it open and act on what arrives". If this
 * connection never opens, or opens and later drops, nothing here notices or retries — the
 * periodic poll above is untouched and keeps running exactly as it does today, which is
 * what keeps a dead stream from being worse than no stream at all (see
 * CB_STREAM_IDLE_TIMEOUT_S above for the one number that bounds how long a silent
 * connection is left believing itself alive).
 *
 * This class owns only the transport — framing SSE chunks into named events — and never
 * touches cb_state_* itself; `cb_stream_handle_event` below is the one place that
 * decides what an event NAME means. Forward-declared here because the delegate method
 * that calls it is defined above its own definition. */
static void cb_stream_handle_event(NSString *name);

/* Ticket 03's reconnect, forward-declared for the same reason cb_stream_handle_event above
 * is: CBEventStream's own `didCompleteWithError:` schedules a call to this function, and
 * its real definition sits below the class that calls it. */
static void cb_stream_start(dispatch_semaphore_t connectedSem);

/* The backoff's own mutable state — see CB_STREAM_RECONNECT_INITIAL_S near the top of the
 * file for what the two numbers it walks between mean. `cb_stream_had_failure` is what
 * lets `didReceiveResponse:` below tell a RECONNECT apart from the very first connect at
 * process start, which needs no catch-up poll of its own — see that method. */
static double cb_stream_backoff_s = CB_STREAM_RECONNECT_INITIAL_S;
static int cb_stream_had_failure = 0;

/* Doubles the backoff (capped at CB_STREAM_RECONNECT_MAX_S) and arranges for
 * `cb_stream_start` to run again once it elapses, on `cb_poll_queue` — the same serial
 * queue every request in this process already goes out on, so a reconnect can never race a
 * poll or a popover action into existence. Shared by CBEventStream's own
 * `didCompleteWithError:` below and by `cb_stream_start` itself for the one failure that
 * delegate callback can never report at all: no secret to open the connection with in the
 * first place. `cb_poll_queue` is nil only if this is somehow called before either
 * `cb_menubar` or a probe mode has set it up, which no caller in this file does. */
static void cb_stream_schedule_reconnect(void) {
  cb_stream_had_failure = 1;
  double backoff = cb_stream_backoff_s;
  cb_stream_backoff_s = fmin(cb_stream_backoff_s * 2.0, CB_STREAM_RECONNECT_MAX_S);
  if (cb_poll_queue == nil) return;
  dispatch_time_t when = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(backoff * (double)NSEC_PER_SEC));
  dispatch_after(when, cb_poll_queue, ^{
    cb_stream_start(nil);
  });
}

@interface CBEventStream : NSObject <NSURLSessionDataDelegate>
@property(nonatomic, strong) NSMutableData *buffer;
/* Signalled once, the instant the daemon's response headers land with a 200 — a test
 * seam for `--menubar --probe live` below, exactly the role CBStreamProbe's headersSem
 * plays for `--probe stream`. nil in the real run loop, which has no caller waiting to be
 * told when it is safe to trigger a daemon-side change. */
@property(nonatomic, strong) dispatch_semaphore_t connectedSem;
@end

@implementation CBEventStream

- (instancetype)init {
  self = [super init];
  if (self != nil) _buffer = [NSMutableData data];
  return self;
}

- (void)URLSession:(NSURLSession *)session
              dataTask:(NSURLSessionDataTask *)task
    didReceiveResponse:(NSURLResponse *)response
     completionHandler:(void (^)(NSURLSessionResponseDisposition disposition))completionHandler {
  (void)session;
  (void)task;
  NSInteger status =
      [response isKindOfClass:[NSHTTPURLResponse class]] ? [(NSHTTPURLResponse *)response statusCode] : 0;
  if (status == 200) {
    /* A live subscription again. Reset the backoff so the NEXT drop starts counting from
     * CB_STREAM_RECONNECT_INITIAL_S rather than carrying forward whatever a run of earlier
     * failures grew it to — and, only if THIS connection followed at least one failure, fire
     * a fresh poll to catch up on anything a `pomodoro` or `waiting` event might have
     * carried while nothing was listening. Skipped on the very first connect at process
     * start (`cb_stream_had_failure` is still 0 then): the periodic poll already fires at
     * DISPATCH_TIME_NOW beside it, and a second redundant fetch a moment later would buy
     * nothing. Either way, this never touches cb_state_answered_at itself — only
     * cb_poll_once does that, on an actual successful fetch — so a reconnect alone can never
     * make stale data look fresh (criterion 5); it can only ever trigger the SAME real fetch
     * a button press or a pushed event already does. */
    cb_stream_backoff_s = CB_STREAM_RECONNECT_INITIAL_S;
    if (cb_stream_had_failure) {
      cb_stream_had_failure = 0;
      if (cb_poll_queue != nil) dispatch_async(cb_poll_queue, ^{ cb_poll_once(); });
    }
    if (self.connectedSem != nil) dispatch_semaphore_signal(self.connectedSem);
  }
  completionHandler(NSURLSessionResponseAllow);
}

/* Refuses every redirect, the same policy and the same reason `CBNoRedirectDelegate` (near
 * `cb_request`) and `CBStreamProbe`'s own copy above both carry — this connection is held
 * for the length of a login session and authorized by the same secret header, so it is no
 * less exposed to a hijacked port's `Location:` than either of them. A refused redirect's
 * response arrives at `didReceiveResponse:` above like any other: `status != 200` leaves
 * the connection never marked live, and `didCompleteWithError:` below runs its ordinary
 * reconnect-and-forget-the-secret path once the response body (if any) finishes. */
- (void)URLSession:(NSURLSession *)session
                          task:(NSURLSessionTask *)task
    willPerformHTTPRedirection:(NSHTTPURLResponse *)response
                    newRequest:(NSURLRequest *)request
             completionHandler:(void (^)(NSURLRequest *))completionHandler {
  (void)session;
  (void)task;
  (void)response;
  (void)request;
  completionHandler(nil);
}

/* Ticket 03: every way this connection can end — the daemon dropping it, never answering at
 * all, a non-200 response finishing its own short body, the idle timeout above — arrives
 * here exactly once, `error` nil only for the last of those, and every one of them means the
 * same thing: there is no live subscription any more. Reruns `cb_stream_start` itself,
 * rather than anything narrower, on the backoff `cb_stream_schedule_reconnect` arranges —
 * which is what makes a daemon restart transparent: the next attempt reads cb_port() and
 * cb_secret() again from scratch, exactly as the very first connection did, and picks up a
 * rotated secret meanwhile (cb_forget_secret, the same policy cb_request already carries for
 * every other route). `nil` for `connectedSem`, always: only `--menubar --probe live`'s own
 * FIRST connection ever wants one, and it has no second wait armed for whatever a reconnect
 * this deep into a run finds. */
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  (void)session;
  (void)task;
  (void)error;
  cb_forget_secret();
  cb_stream_schedule_reconnect();
}

/* Frames are `\n\n`-terminated (PROTOCOL.md "SSE events"), so this looks for a complete one
 * before doing any work, and DISCARDS what it consumed from the buffer — unlike
 * CBStreamProbe above, which is a one-shot probe that reads only its first event and
 * exits. This connection is held for a login session, so a buffer that only ever grew
 * would be a slow leak against a process nothing restarts. A decode that fails (a
 * multi-byte character split across two chunks) leaves the bytes in the buffer for the
 * next chunk to complete, same reasoning CBStreamProbe's own comment gives. */
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
  (void)session;
  (void)task;
  [self.buffer appendData:data];
  NSData *sep = [@"\n\n" dataUsingEncoding:NSUTF8StringEncoding];
  for (;;) {
    NSRange found = [self.buffer rangeOfData:sep options:0 range:NSMakeRange(0, self.buffer.length)];
    if (found.location == NSNotFound) break;
    NSData *frameData = [self.buffer subdataWithRange:NSMakeRange(0, found.location)];
    NSString *frame = [[NSString alloc] initWithData:frameData encoding:NSUTF8StringEncoding];
    if (frame == nil) break;  // incomplete multi-byte sequence; wait for the next chunk
    [self.buffer replaceBytesInRange:NSMakeRange(0, found.location + sep.length) withBytes:NULL length:0];
    for (NSString *line in [frame componentsSeparatedByString:@"\n"]) {
      if (![line hasPrefix:@"event:"]) continue;
      NSString *name = [[line substringFromIndex:6]
          stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
      cb_stream_handle_event(name);
      break;
    }
  }
}

@end

/* Strong, file-scope, same reasoning as cb_popover: a session's delegate is not retained
 * anywhere else, and a task's own reference is not enough to keep the session it belongs
 * to alive for the length of a login session. */
static NSURLSession *cb_stream_session = nil;
static CBEventStream *cb_stream_delegate = nil;

/* The one thing an event NAME means: `pomodoro` and `waiting` both become the exact same
 * re-poll a button press already triggers (cb_dispatch_action's own trailing
 * `cb_poll_once`). Anything else — a future event name this build predates — is silently
 * ignored, the same closed-set discipline cb_phase_from applies to an unrecognised phase
 * string: an unknown event is not evidence of nothing, only of nothing THIS build knows
 * how to act on. */
static void cb_stream_handle_event(NSString *name) {
  if (![name isEqualToString:@"pomodoro"] && ![name isEqualToString:@"waiting"]) return;
  if (cb_poll_queue == nil) return;
  dispatch_async(cb_poll_queue, ^{
    cb_poll_once();
  });
}

/* Opens `GET /api/events` and holds it for as long as the connection lasts — and, as of
 * ticket 03, is also what every RECONNECT calls to try again: CBEventStream's own
 * `didCompleteWithError:` schedules a fresh call to this exact function after a backoff, so
 * there is only one way this file ever opens the stream, whether it is the very first
 * attempt of a login session or the fiftieth after a flaky network. A missing secret is no
 * longer a dead end either — it schedules its own retry through the same backoff, because
 * the daemon (and the secret file HOME derives) can appear after this process does, and
 * giving up here would mean nothing ever tried again for the rest of the login session.
 * Either way, the periodic poll beside it is what a reader gets meanwhile, exactly as it
 * already does today.
 *
 * `connectedSem` is the test seam CBEventStream's own doc comment names; nil from the real
 * run loop (cb_menubar below) and from every RECONNECT, which pass nothing because nothing
 * there is waiting to be told THIS particular attempt succeeded. */
static void cb_stream_start(dispatch_semaphore_t connectedSem) {
  NSString *secret = cb_secret();
  if (secret == nil) {
    cb_stream_schedule_reconnect();
    return;
  }

  /* A reconnect replaces the session wholesale rather than reusing the old one's task —
   * NSURLSession task objects are one-shot, and reissuing a request on an already-completed
   * one is not a thing the API supports. Tear the previous session down first so a login
   * session with many drops does not grow one abandoned NSURLSession per reconnect: nil the
   * very first time this ever runs, the just-completed session every time after — its own
   * task is already done (that is why this is running at all), so this only releases what
   * is left of it rather than cancelling anything still in flight. */
  if (cb_stream_session != nil) [cb_stream_session invalidateAndCancel];

  NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%d%s", cb_port(), "/api/events"]];
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url
                                                        cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                                    timeoutInterval:CB_STREAM_IDLE_TIMEOUT_S];
  [request setValue:secret forHTTPHeaderField:@"x-claude-board-secret"];
  request.HTTPMethod = @"GET";

  cb_stream_delegate = [[CBEventStream alloc] init];
  cb_stream_delegate.connectedSem = connectedSem;
  cb_stream_session =
      [NSURLSession sessionWithConfiguration:[NSURLSessionConfiguration ephemeralSessionConfiguration]
                                     delegate:cb_stream_delegate
                                delegateQueue:nil];
  NSURLSessionDataTask *task = [cb_stream_session dataTaskWithRequest:request];
  [task resume];
}

/* --- The drawing ----------------------------------------------------------------------
 *
 * The widget's own geometry, redrawn in AppKit rather than parsed out of the SVG: a
 * 24-unit viewBox, round caps and joins, and src/pomodoro-widget.mjs's TOMATO_ICON is the
 * silhouette every state here starts from — `circle cx=12 cy=14.6 r=6.8` at stroke-width
 * 2, a stem and two leaves above it. The ring and the two centre marks are the rest of
 * ADR 84's vocabulary, and each one's `d` attribute is quoted beside the code that draws
 * it, below. Every number here is lifted from one of those strings.
 *
 * SVG's y grows downward and AppKit's grows up, so each y is mirrored through
 * `CB_SVG_Y(y)` once, here, and every coordinate after that is ordinary y-up AppKit. That
 * is one conversion in one place instead of a flipped CTM whose sign then has to be
 * carried into the ring's direction as well. */
#define CB_SVG_Y(y) (24.0 - (y))

static const double CB_CIRCLE_X = 12.0;
static const double CB_CIRCLE_Y = 9.4;   /* CB_SVG_Y(14.6) */
static const double CB_CIRCLE_R = 6.8;
static const double CB_STROKE = 2.0;

/* The ring rides JUST INSIDE the outline and is thinner than it, so the two read as one
 * glyph with a gauge on it rather than as two circles. r 4.9 against the outline's 6.8
 * leaves a clear 1.9 units of gap at stroke-width 1.5, and — the point of the whole move —
 * an interior the centre marks below have entirely to themselves. */
static const double CB_RING_R = 4.9;
static const double CB_RING_STROKE = 1.5;

/* The rest bar is HEAVIER than the outline (2.2 against 2.0), because it is short and sits
 * alone in the middle of a lot of white; at the outline's own weight it read as a scratch. */
static const double CB_REST_STROKE = 2.2;

/* The item's image, in points. 18 tall is the most a 22pt menu bar takes without crowding
 * it. CB_SCALE maps the 24-unit box into that height: the ink spans y 4.6..21.4 in SVG
 * units plus half a stroke either side, i.e. 18.8 units, and 0.82 leaves a hair of margin
 * inside 18pt. CB_INK_CENTER_Y is where that ink is centred (y-up), and every state draws
 * the same silhouette now, so it is the one centre for all of them.
 *
 * The width is the glyph's own CB_GLYPH_W plus 3pt of EMPTY IMAGE to the right of it, and
 * that 3pt is the space between the icon and the countdown (criterion 10, ADR 83). Buying
 * it here rather than by padding the title is what keeps it out of the button: an
 * NSImageLeft button abuts image and title with nothing between them, a leading space in
 * the title would be trimmed by the monospaced-digit layout it is measured with, and an
 * attributed title would be reaching back for the styling this file spends its whole
 * appearance story avoiding. The ink is centred in CB_GLYPH_W rather than in CB_ICON_W, so
 * the extra width lands entirely on the countdown's side. */
static const double CB_GLYPH_W = 15.0;
static const double CB_ICON_W = 18.0;    /* CB_GLYPH_W + 3pt of space before the digits */
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
 * So there is no amber for work here, and no labelColor/secondaryLabelColor either. Every
 * state is told apart by SHAPE alone (ADR 80, narrowed by 84), which is what they were
 * drawn for: shape survives Increase Contrast, and it survives being a template image.
 *
 * Alpha is the one channel that survives templating, because alpha IS the mask — and
 * after ADR 84 it carries EXACTLY ONE FACT, that the daemon has stopped answering. There
 * are two values here and there is no third. Idle and paused are drawn at full weight
 * like everything else and told apart by what is or is not in the middle of them, because
 * a second meaning for alpha is a reader having to tell 0.62 from 0.35 at a glance in a
 * menu bar whose ink they do not control. If a future state seems to want a third weight,
 * it wants a shape instead. */
static const CGFloat CB_ALPHA_FULL = 1.0;
static const CGFloat CB_ALPHA_STALE = 0.35;

/* Black is arbitrary and unused: only the alpha reaches the screen. Spelled explicitly
 * rather than as `[NSColor blackColor]` so nobody later "fixes" it to a semantic colour
 * on the belief that it is doing something. */
static NSColor *cb_mask(CGFloat alpha) {
  return [NSColor colorWithWhite:0.0 alpha:alpha];
}

static CGFloat cb_ink_alpha(cb_display d) {
  return d.answered ? CB_ALPHA_FULL : CB_ALPHA_STALE;
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
  [cb_mask(cb_ink_alpha(d)) setStroke];

  /* The silhouette, and it is drawn in EVERY state including the breaks (ADR 84) — the
   * break glyph's old stemlessness is gone, and with it the moment where the menu bar
   * appeared to swap in a different icon every twenty-five minutes. TOMATO_ICON's own
   * `<circle cx="12" cy="14.6" r="6.8"/>`, its `M12 7.8V4.6` stem and its two leaves
   * `M12 7.8 8.2 5.9M12 7.8l3.8-1.9`. */
  NSBezierPath *outline = cb_path();
  [outline appendBezierPathWithOvalInRect:NSMakeRect(CB_CIRCLE_X - CB_CIRCLE_R,
                                                     CB_CIRCLE_Y - CB_CIRCLE_R,
                                                     CB_CIRCLE_R * 2.0, CB_CIRCLE_R * 2.0)];
  cb_line(outline, 12.0, 7.8, 12.0, 4.6);
  cb_line(outline, 12.0, 7.8, 8.2, 5.9);
  cb_line(outline, 12.0, 7.8, 15.8, 5.9);
  [outline stroke];

  /* Time remaining, and the only thing that carries it: a thin ring just inside the
   * outline, `<circle cx="12" cy="14.6" r="4.9"/>` at stroke-width 1.5, drawn as a real
   * arc rather than the render's dasharray. No track behind it — the ring simply gets
   * shorter, which is what makes "how much is left" readable with the digits switched off.
   * Twelve o'clock is 90 degrees in a y-up space and the sweep runs clockwise from there,
   * the direction every dial in the world runs.
   *
   * Work is the only state that draws it (cb_derive), so the ring and a centre mark never
   * appear together any more — but it still keeps clear of r 4.9, because a fill here, the
   * shape this used to take, is what occluded the centre and is not coming back. */
  if (d.ring && d.fraction > 0.0) {
    NSBezierPath *ring = cb_path();
    ring.lineWidth = CB_RING_STROKE;
    [ring appendBezierPathWithArcWithCenter:NSMakePoint(CB_CIRCLE_X, CB_CIRCLE_Y)
                                     radius:CB_RING_R
                                 startAngle:90.0
                                   endAngle:90.0 - 360.0 * d.fraction
                                  clockwise:YES];
    [ring stroke];
  }

  if (d.mark == CB_MARK_REST) {
    /* REST_ICON's `M9.4 14.6h5.2` at stroke-width 2.2 — ONE flat bar, and the same one for
     * a short break and a long break alike. */
    NSBezierPath *bar = cb_path();
    bar.lineWidth = CB_REST_STROKE;
    cb_line(bar, 9.4, 14.6, 14.6, 14.6);
    [bar stroke];
  } else if (d.mark == CB_MARK_PAUSED) {
    /* `M10.4 12.2v4.8M13.6 12.2v4.8` — the pause glyph everyone already knows, and the one
     * pair of vertical bars in this whole vocabulary. Nothing else may draw them: they are
     * what "paused" means here now that the countdown beside them is empty. */
    NSBezierPath *bars = cb_path();
    cb_line(bars, 10.4, 12.2, 10.4, 17.0);
    cb_line(bars, 13.6, 12.2, 13.6, 17.0);
    [bars stroke];
  }
}

/* A fresh image per tick — the ring and the digits need one anyway — marked as a template
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
                             /* CB_GLYPH_W, not CB_ICON_W: the ink is centred in the
                              * glyph's own share of the box and the remainder is left
                              * empty on the right, which is criterion 10's gap. */
                             [fit translateXBy:CB_GLYPH_W / 2.0 yBy:CB_ICON_H / 2.0];
                             [fit scaleBy:CB_SCALE];
                             [fit translateXBy:-CB_CIRCLE_X yBy:-CB_INK_CENTER_Y];
                             [fit concat];
                             cb_draw(d);
                             return YES;
                           }];
  image.template = YES;
  return image;
}

/* --- The widget's icons, from their own path data --------------------------------------
 *
 * The popover draws four glyphs and invents none of them: the phase glyph above (cb_draw,
 * the same drawing the status item makes) plus a gear, a restart and a forward, which are
 * src/pomodoro-widget.mjs's GEAR_ICON, RESTART_ICON and FORWARD_ICON. Objective-C cannot
 * import those strings, so the alternative was to copy each one's numbers into AppKit calls
 * by hand — which is what cb_draw does above, correctly, for shapes made of lines and one
 * circle. The gear is not that shape: it is a dozen elliptical-arc commands, and
 * hand-converting each of them to a centre, a radius and two angles is both the fiddliest
 * work in this file and the kind that drifts silently the day somebody nudges the widget.
 *
 * So this walks the `d` string ITSELF, verbatim, exactly as the widget writes it. The copy
 * is a byte copy rather than a transcription, which is what makes "the two surfaces draw
 * the same glyph" a thing test/check-menubar-client.mjs can assert by comparing the two
 * files' bytes instead of a promise nobody can check. The parser is deliberately narrow:
 * the commands these three icons use and no others (M/m, L/l, H/h, V/v, A/a, Z/z — there
 * is not one curve among them), no exponent notation, and circular arcs only. Anything
 * else stops the walk rather than guessing, and the icons are pinned so that a future
 * widget edit reaching for a `C` fails a check rather than dropping half a glyph.
 *
 * SVG's y grows downward, so every point goes through CB_SVG_Y once on the way in, the
 * same single conversion cb_draw makes. */

/* One number out of a path-data string, in the grammar SVG actually uses rather than the
 * one a naive split on spaces assumes: `-` both negates and separates (`l-.06-.06` is two
 * numbers), `.32` may have no leading zero, and commas are whitespace. Returns 0 when the
 * next token is not a number, which is how every caller below learns the run has ended. */
static int cb_svg_number(const char **p, double *out) {
  const char *s = *p;
  while (*s == ' ' || *s == ',' || *s == '\t' || *s == '\n' || *s == '\r') s++;
  const char *start = s;
  if (*s == '-' || *s == '+') s++;
  int digits = 0;
  while (*s >= '0' && *s <= '9') { s++; digits++; }
  if (*s == '.') {
    s++;
    while (*s >= '0' && *s <= '9') { s++; digits++; }
  }
  if (digits == 0) return 0;
  *out = strtod(start, NULL);
  *p = s;
  return 1;
}

/* One `A`/`a` segment, endpoint form in, centre form out — the conversion SVG's own
 * appendix F.6.5 specifies, restricted to the circular case (rx == ry, no x-rotation),
 * which is every arc in these three icons.
 *
 * Two details that are not decoration. The radius is scaled up when it is too small to
 * span the two endpoints, which the spec requires and which is not hypothetical here: the
 * gear's `a2 2 0 1 1-2.83 2.83` asks a radius-2 circle to cover 4.002 units, and without
 * the correction the term under the square root is negative — a NaN centre if it were
 * taken, and an arc drawn at a radius that does not reach its own endpoints once the clamp
 * below has caught it. And the sweep flag survives the flip to AppKit's y-up space
 * unchanged: the mirror turns the arc's angles around, so a sweep the SVG draws clockwise
 * on screen is still drawn clockwise on screen, which is what `clockwise:` means here.
 *
 * The clamp is float noise insurance rather than the correction's understudy: after the
 * scale-up the term is zero at worst, and zero is a legitimate half-circle. */
static void cb_svg_arc(NSBezierPath *path, double x0, double y0, double rx, double ry,
                       double large, double sweep, double x1, double y1) {
  double dx = x1 - x0, dy = y1 - y0;
  double span = sqrt(dx * dx + dy * dy);
  if (span == 0.0) return;                       /* the spec: a zero-length arc is omitted */
  double r = fabs(rx) > fabs(ry) ? fabs(rx) : fabs(ry);
  if (r * 2.0 < span) r = span / 2.0;
  double half = span / 2.0;
  double h2 = r * r - half * half;
  double h = h2 > 0.0 ? sqrt(h2) : 0.0;
  double ux = dx / span, uy = dy / span;
  /* Which side of the chord the centre falls on: the spec's ± is + when exactly one of the
   * two flags is set. */
  double side = (large != 0.0) != (sweep != 0.0) ? 1.0 : -1.0;
  double cx = (x0 + x1) / 2.0 + side * h * -uy;
  double cy = (y0 + y1) / 2.0 + side * h * ux;
  double start = atan2(y0 - cy, x0 - cx) * 180.0 / M_PI;
  double end = atan2(y1 - cy, x1 - cx) * 180.0 / M_PI;
  [path appendBezierPathWithArcWithCenter:NSMakePoint(cx, CB_SVG_Y(cy))
                                   radius:r
                               startAngle:-start
                                 endAngle:-end
                                clockwise:sweep != 0.0];
}

/* The walk itself. `command` persists across coordinate sets, which is the implicit-repeat
 * rule every one of these icons leans on (`a1.6 1.6 0 0 0 .32 1.77 1.6 1.6 0 0 0-1 1.47`
 * is two arcs and one letter); the one exception is a moveto, whose repeats are linetos. */
static void cb_svg_path(NSBezierPath *path, const char *d) {
  double x = 0.0, y = 0.0, sx = 0.0, sy = 0.0;
  char command = 0;
  const char *p = d;
  while (*p != '\0') {
    while (*p == ' ' || *p == ',' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p == '\0') break;
    BOOL letter = strchr("MmLlHhVvAaZz", *p) != NULL;
    if (letter) command = *p++;
    else if (command == 0) return;               /* data before any command: not ours */
    double a = 0.0, b = 0.0, rx = 0.0, ry = 0.0, large = 0.0, sweep = 0.0;
    switch (command) {
      case 'Z':
      case 'z':
        [path closePath];
        x = sx;
        y = sy;
        command = 0;
        continue;
      case 'M':
      case 'm':
        if (!cb_svg_number(&p, &a) || !cb_svg_number(&p, &b)) return;
        if (command == 'm') { a += x; b += y; }
        if (letter) {
          [path moveToPoint:NSMakePoint(a, CB_SVG_Y(b))];
          sx = a;
          sy = b;
        } else {
          [path lineToPoint:NSMakePoint(a, CB_SVG_Y(b))];
        }
        x = a;
        y = b;
        break;
      case 'L':
      case 'l':
        if (!cb_svg_number(&p, &a) || !cb_svg_number(&p, &b)) return;
        if (command == 'l') { a += x; b += y; }
        [path lineToPoint:NSMakePoint(a, CB_SVG_Y(b))];
        x = a;
        y = b;
        break;
      case 'H':
      case 'h':
        if (!cb_svg_number(&p, &a)) return;
        if (command == 'h') a += x;
        [path lineToPoint:NSMakePoint(a, CB_SVG_Y(y))];
        x = a;
        break;
      case 'V':
      case 'v':
        if (!cb_svg_number(&p, &b)) return;
        if (command == 'v') b += y;
        [path lineToPoint:NSMakePoint(x, CB_SVG_Y(b))];
        y = b;
        break;
      case 'A':
      case 'a':
        /* Seven numbers: rx, ry, the x-rotation (read into `a` and discarded — every arc
         * in these icons is circular, so there is nothing for a rotation to do), the two
         * flags, and the endpoint. */
        if (!cb_svg_number(&p, &rx) || !cb_svg_number(&p, &ry) || !cb_svg_number(&p, &a) ||
            !cb_svg_number(&p, &large) || !cb_svg_number(&p, &sweep) ||
            !cb_svg_number(&p, &a) || !cb_svg_number(&p, &b)) return;
        if (command == 'a') { a += x; b += y; }
        cb_svg_arc(path, x, y, rx, ry, large, sweep, a, b);
        x = a;
        y = b;
        break;
      default:
        return;
    }
  }
}

/* A `points` list, which is what `<polyline>` and `<polygon>` carry instead of a `d` — the
 * same verbatim copy, so the restart icon's `1 4 1 10 7 10` is the widget's own string and
 * not three pairs retyped. `close` is the only difference between the two elements. */
static void cb_svg_points(NSBezierPath *path, const char *points, BOOL close) {
  const char *p = points;
  double px = 0.0, py = 0.0;
  BOOL first = YES;
  while (cb_svg_number(&p, &px) && cb_svg_number(&p, &py)) {
    NSPoint point = NSMakePoint(px, CB_SVG_Y(py));
    if (first) {
      [path moveToPoint:point];
      first = NO;
    } else {
      [path lineToPoint:point];
    }
  }
  if (close && !first) [path closePath];
}

/* The three icons, each one nothing but its own element list read off
 * src/pomodoro-widget.mjs. The strings are quoted here as literals rather than described in
 * a comment beside hand-converted numbers, which is the whole point: this IS the copy. */

/* GEAR_ICON: a `<circle cx="12" cy="12" r="3.2"/>` and one path, at stroke-width 2.2. */
static const double CB_GEAR_STROKE = 2.2;
static const double CB_GEAR_CIRCLE_R = 3.2;
static const char *const CB_GEAR_PATH =
    "M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9.1 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z";

/* RESTART_ICON: rotate-ccw, a `<polyline>` and a path. */
static const char *const CB_RESTART_POINTS = "1 4 1 10 7 10";
static const char *const CB_RESTART_PATH = "M3.51 15a9 9 0 1 0 2.13-9.36L1 10";

/* FORWARD_ICON: skip-forward, a `<polygon>` and a `<line x1="19" y1="5" x2="19" y2="19"/>`.
 * The line is two endpoints rather than a string, cb_line being what this file already
 * uses for exactly that. */
static const char *const CB_FORWARD_POINTS = "5 4 15 12 5 20";

static NSBezierPath *cb_gear_path(void) {
  NSBezierPath *path = cb_path();
  path.lineWidth = CB_GEAR_STROKE;
  [path appendBezierPathWithOvalInRect:NSMakeRect(12.0 - CB_GEAR_CIRCLE_R,
                                                  CB_SVG_Y(12.0) - CB_GEAR_CIRCLE_R,
                                                  CB_GEAR_CIRCLE_R * 2.0, CB_GEAR_CIRCLE_R * 2.0)];
  cb_svg_path(path, CB_GEAR_PATH);
  return path;
}

static NSBezierPath *cb_restart_path(void) {
  NSBezierPath *path = cb_path();
  cb_svg_points(path, CB_RESTART_POINTS, NO);
  cb_svg_path(path, CB_RESTART_PATH);
  return path;
}

static NSBezierPath *cb_forward_path(void) {
  NSBezierPath *path = cb_path();
  cb_svg_points(path, CB_FORWARD_POINTS, YES);
  cb_line(path, 19.0, 5.0, 19.0, 19.0);
  return path;
}

/* The widget draws these three at 12 points square and the phase glyph at 13, and both
 * numbers are kept: an icon that matched the browser's on one surface and not the other
 * would be the drift this whole section exists to prevent. The two points of padding are
 * image, not ink — a stroke centred on the viewBox edge spills half its width past it, and
 * the gear's teeth sit on that edge. */
static const CGFloat CB_ICON_INK_PT = 12.0;
static const CGFloat CB_ICON_PT = 14.0;
static const CGFloat CB_GLYPH_PT = 13.0;

/* Template images again, and for the same reason the status item's is one (see cb_image):
 * an NSButton hands a template image to AppKit, which tints it with the button's own text
 * colour in whatever appearance the popover is being drawn in. The alpha is the whole
 * picture, so cb_mask's black is a mask here exactly as it is up there, and no colour is
 * named. */
static NSImage *cb_icon_image(NSBezierPath *path) {
  NSImage *image = [NSImage imageWithSize:NSMakeSize(CB_ICON_PT, CB_ICON_PT)
                                  flipped:NO
                           drawingHandler:^BOOL(NSRect rect) {
                             (void)rect;
                             NSAffineTransform *fit = [NSAffineTransform transform];
                             [fit translateXBy:(CB_ICON_PT - CB_ICON_INK_PT) / 2.0
                                           yBy:(CB_ICON_PT - CB_ICON_INK_PT) / 2.0];
                             [fit scaleBy:CB_ICON_INK_PT / 24.0];
                             [fit concat];
                             [cb_mask(CB_ALPHA_FULL) setStroke];
                             [path stroke];
                             return YES;
                           }];
  image.template = YES;
  return image;
}

/* The popover's phase glyph: cb_draw, unchanged, at the size TOMATO_ICON is drawn in the
 * browser. Not a second drawing of the same idea — the ring drains and the centre mark
 * changes here on the same tick they do in the menu bar, because it is one function. */
static NSImage *cb_glyph_image(cb_display d) {
  NSImage *image = [NSImage imageWithSize:NSMakeSize(CB_GLYPH_PT, CB_GLYPH_PT)
                                  flipped:NO
                           drawingHandler:^BOOL(NSRect rect) {
                             (void)rect;
                             NSAffineTransform *fit = [NSAffineTransform transform];
                             [fit translateXBy:CB_GLYPH_PT / 2.0 yBy:CB_GLYPH_PT / 2.0];
                             [fit scaleBy:CB_GLYPH_PT / 24.0];
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
 * status item is tracking, and that trap is exactly this one), and a switch and two buttons
 * that are real controls rather than menu rows pretending to be some. It costs roughly
 * double the line count, and it makes light and dark, Reduce Transparency, Increase
 * Contrast, focus rings and full keyboard access this repo's problem rather than NSMenu's.
 *
 * The whole strategy against that bill is: DO NOT STYLE ANYTHING. Every control here is a
 * stock AppKit one at its default appearance, the popover keeps its own material and
 * background, and the only two colours named in the whole section are `secondaryLabelColor`
 * on the captions and `labelColor` on the phase glyph — SEMANTIC names the system resolves
 * per appearance, never values. An NSButton or an NSSwitch nobody touched is already right
 * in every appearance and every accessibility setting, has a focus ring, is reachable
 * under Full Keyboard Access and reports itself to VoiceOver; a hand-drawn row is none of
 * those, for each of which this file would then own a bug. It is the same call the
 * template image made after the first build resolved its own colours and read as flat
 * grey.
 *
 * The layout, top to bottom, and the exact words:
 *
 *     [glyph] Work · 12:34        [gear]   status line: phase glyph, phase, gear at the right
 *     [switch] Running  [restart] [fwd]    control row: switch, the state it is IN, restart, forward
 *     ─────────────────────────────
 *     3 waiting for an answer              caption, carrying the count; "Nothing waiting" at zero
 *     • claude-board · round 2             at most five, newest board first
 *     • 3 more waiting                     only when there are more; opens the index
 *
 * Five things about that list are decisions rather than arrangement.
 *
 * The SWITCH is what the index page's widget already uses (`role="switch"`), and it is
 * here for a reason that is not consistency: a switch has ONE design in both of its
 * states, so no control in this popover can render as a filled primary button while its
 * neighbours do not — the complaint is removed by construction rather than styled around.
 * NSSwitch is AppKit's stock spelling of it.
 *
 * The WORD BESIDE IT is the state the switch is in (cb_switch_state_word), where its
 * accessibility label is the action a press performs (cb_switch_label). Both are wanted,
 * and they are different words: a screen reader hears the widget's own sentence, and the
 * reader sees the state nothing else in the popover reports. It is also the one place
 * "paused" is written (ADR 83).
 *
 * The GEAR is the settings row, retired as a row: a glyph with no text and no ellipsis,
 * accessible name "Settings", pinned to the right of the line that names the phase. It
 * opens the index page's own panel, and nothing here is editable — re-implementing four
 * duration fields, two notify toggles and three cue pickers natively is the most expensive
 * part of this feature and buys a panel opened once a month.
 *
 * THERE IS NO "HIDE FROM MENU BAR" ROW, and the absence is the decision: hiding the item
 * is reachable only from the index page's pomodoro settings, because a row that removes
 * the surface you would use to undo it is a one-way door. This process now posts no
 * setting at all (see CB_ACTION_PATHS).
 *
 * A WAITING BOARD is a dot and its label, not a bordered button — but still a real
 * NSButton, with `bordered` off and nothing else touched, because the bezel is the only
 * part the layout drops. A hand-drawn row would lose the focus ring, the keyboard reach and
 * the VoiceOver report along with it. The dot is a typographic bullet in the title rather
 * than a drawn circle, which is what keeps the popover's glyph set exactly equal to the
 * widget's: nothing here is invented for this surface.
 *
 * Reset is absent for a reason that is not about layout at all: there is no reset route
 * reachable from this file (CB_ACTION_PATHS above). */

/* Wide enough for the waiting caption plus a comfortable row, narrow enough that the
 * popover reads as an accessory rather than a window. The row labels are elided to
 * CB_TITLE_MAX above rather than being allowed to widen this. */
static const CGFloat CB_POPOVER_W = 264.0;

/* The floor under -presentRelativeToButton:'s wait for activation to land — see there.
 * Long enough that the notification wins outright in the overwhelmingly common case, short
 * enough that a reader who hits the floor instead reads it as instant rather than as a
 * hang. Not measured against a real deadline (nothing in this repo can watch the window
 * server from a headless run); picked as a value nobody perceives as latency. */
static const double CB_ACTIVATION_FLOOR_S = 0.3;

@interface CBPopover : NSObject
@property(nonatomic, strong) NSPopover *popover;
/* Refreshed by the tick while the popover is open, which is the whole reason this is a
 * popover rather than a menu: the four things whose meaning changes the instant the
 * daemon's state does. Everything else in the row set is a snapshot — see -rebuild. */
@property(nonatomic, strong) NSImageView *glyphView;
@property(nonatomic, strong) NSTextField *statusLine;
@property(nonatomic, strong) NSSwitch *toggle;
@property(nonatomic, strong) NSTextField *stateWord;
/* NOT refreshed by the tick — the row set is a snapshot, same as everything else below
 * this comment's own boundary. Held only so `--menubar --probe layout` (criterion 13) can
 * read their resolved frames back after -buildContentWithDisplay:waiting: without a second
 * copy of -rebuild's own view construction to find them in. */
@property(nonatomic, strong) NSButton *gearButton;
@property(nonatomic, strong) NSButton *forwardButton;
/* Parallel to the row buttons' `tag`s. An NSString rather than an NSURL because the
 * validator that decides whether it may be opened is a C function taking a C string. */
@property(nonatomic, strong) NSArray<NSString *> *rowURLs;
/* Non-nil only between requesting activation and the popover actually showing — see
 * -presentRelativeToButton:. Held so a second click arriving in that window replaces the
 * wait rather than stacking a second observer behind it. */
@property(nonatomic, strong) id activationObserver;
@end

/* A stock push button carrying one of the widget's icons and no text at all. The
 * accessibility label is therefore the ONLY name the control has, which is why an
 * icon-only control must carry one — the same rule src/pomodoro-widget.mjs's own comment
 * states for the three it draws. Nothing here sets a colour, a font, a bezel or a
 * background: a template image inside an untouched NSButton is tinted by AppKit with the
 * button's own text colour, in whatever appearance it is drawn in. */
static NSButton *cb_icon_button(NSImage *image, NSString *accessibility, id target, SEL action) {
  NSButton *button = [NSButton buttonWithImage:image target:target action:action];
  [button setAccessibilityLabel:accessibility];
  button.toolTip = accessibility;
  return button;
}

/* A waiting row: a dot, then the label, left-aligned, and no bezel. All three are the
 * layout the popover was redrawn to (see the section comment) rather than styling — the
 * ink, the focus ring, the highlight and the VoiceOver report are still the system's, and
 * `accessibility` replaces the title outright for a screen reader, so the bullet is never
 * spoken.
 *
 * Left-aligned because a centred board title reads as a label and truncates from the
 * middle; the labels themselves are already elided to CB_TITLE_MAX above. */
static NSButton *cb_row_button(NSString *title, NSString *accessibility, id target, SEL action, NSInteger tag) {
  NSButton *button = [NSButton buttonWithTitle:[@"• " stringByAppendingString:title]
                                        target:target
                                        action:action];
  button.tag = tag;
  [button setAccessibilityLabel:accessibility];
  button.alignment = NSTextAlignmentLeft;
  button.bordered = NO;
  return button;
}

static NSTextField *cb_caption(NSString *text, BOOL secondary) {
  NSTextField *label = [NSTextField labelWithString:text];
  /* One of the two appearance decisions in the whole popover, and it is a SEMANTIC colour
   * rather than a value: `secondaryLabelColor` is what the system means by "this is a
   * caption", and it resolves itself in light, in dark and under Increase Contrast. */
  if (secondary) label.textColor = [NSColor secondaryLabelColor];
  return label;
}

/* One priority point below NSButton/NSSwitch/NSImageView's own default horizontal
 * hugging (NSLayoutPriorityDefaultLow, 250 — every one of this row's OTHER arranged
 * subviews is left at it). Measured (see the diagnosis this ticket inherited): setting
 * the label to that SAME value does not make it "loose" relative to its neighbours, it
 * ties with them, and Auto Layout is then free to stretch ANY view in the tie to absorb
 * a row's slack — it chose the phase glyph, an NSImageView, stretching it to 107.5pt in a
 * 264pt panel. One point of separation is enough to make the label the only view that
 * ever loses a hugging tie in this row. */
static const NSLayoutPriority CB_TEXT_HUGGING = NSLayoutPriorityDefaultLow - 1;

/* A row that has to hold a control at each end and text in the middle: the text takes the
 * slack and truncates, so nothing on the right is ever pushed off the popover by a long
 * phase name or a wide state word. Layout, not styling. */
static void cb_fill_with(NSTextField *label) {
  label.lineBreakMode = NSLineBreakByTruncatingTail;
  label.maximumNumberOfLines = 1;
  [label setContentHuggingPriority:CB_TEXT_HUGGING
                    forOrientation:NSLayoutConstraintOrientationHorizontal];
  [label setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow
                                  forOrientation:NSLayoutConstraintOrientationHorizontal];
}

static NSStackView *cb_row(NSArray<NSView *> *views) {
  NSStackView *row = [NSStackView stackViewWithViews:views];
  row.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  row.distribution = NSStackViewDistributionFill;
  row.spacing = 7.0;
  return row;
}

/* The index page, and the fragment that opens its pomodoro panel explicitly.
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
 * bin/notify.m's shape for the same errand.
 *
 * A PLAIN open, and after ADR 93 that is what the name means: it opens, every time, and
 * whether a second tab on the same page now exists is the browser's business. Two of the
 * three callers want exactly that — the index page and the settings panel are one page
 * apiece, not a board a reviewer is sitting in front of. The third, -pressRow:, asks
 * cb_surface_tab first and only lands here when nothing was already showing that board. */
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

/* ADR 81: the popover takes focus, and closes when it loses it. `-[NSNotificationCenter
 * addObserver:selector:...]` rather than the block form, because this one lives for the
 * whole process (cb_popover is never deallocated) and never needs removing — see
 * -applicationDidResignActive:. */
- (instancetype)init {
  self = [super init];
  if (self != nil) {
    [[NSNotificationCenter defaultCenter] addObserver:self
                                              selector:@selector(applicationDidResignActive:)
                                                  name:NSApplicationDidResignActiveNotification
                                                object:nil];
  }
  return self;
}

/* The other half of ADR 81. A transient NSPopover already closes on an outside click; it
 * does not close on Cmd-Tab or a click that lands on another app's Dock icon, neither of
 * which is a click inside THIS app for the popover's own event monitor to catch — both
 * are exactly "resigning active" instead, so that is the signal this file watches for.
 * `performClose:` is a no-op when nothing is shown, which covers every resignation that
 * has nothing to do with an open popover. */
- (void)applicationDidResignActive:(NSNotification *)note {
  (void)note;
  [self.popover performClose:nil];
}

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
  [self presentRelativeToButton:button];
  /* And a fresh poll behind the open, so the rows the NEXT open draws are current even if
   * this one caught the list a moment before a round was answered. */
  if (cb_poll_queue != nil) dispatch_async(cb_poll_queue, ^{ cb_poll_once(); });
}

/* `activateWithOptions:` — rather than -[NSApplication activateIgnoringOtherApps:], which
 * is deprecated as of macOS 14 and would fail the build's own warning-free check, and
 * rather than -[NSApplication activate], which does not exist before it — is also
 * ASYNCHRONOUS: it requests activation and returns before the window server has actually
 * handed this accessory app the active slot. Calling it and showing the popover in the
 * same breath, which this file used to do, raced that: the window came up before
 * activation had landed, so it opened neither key nor active — desaturated material
 * (criterion 1) and deaf to the outside click and the resign-active notification above
 * (criterion 2), because both are properties of a window that is actually key. Waiting for
 * `NSApplicationDidBecomeActiveNotification` is what makes activation land BEFORE the
 * popover shows, rather than racing it; when the app is already active (every open after
 * the first, since nothing here deactivates it again) the notification would never arrive,
 * so that case shows immediately instead of waiting on an event nobody is going to send.
 *
 * That wait has no floor of its own, and a wait with no floor is a hazard the fix it buys
 * does not cover: if activation is ever refused, swallowed, or merely slow, the status
 * item would eat the click and show nothing at all — trading a desaturated popover (the
 * bug ADR 81 fixes) for a dead control, which is worse. CB_ACTIVATION_FLOOR_S is that
 * floor: -showIfWaitingOn:relativeToButton: also runs from a timer, and shows on whichever
 * of the two arrives first. Both close over the SAME token (the notification observer this
 * call is about to register) rather than reading `self.activationObserver` directly at
 * schedule time, so a second click that supersedes this wait — which nils the property out
 * from under the first token below before installing its own — leaves both of this call's
 * paths finding a mismatch and doing nothing, rather than showing a stale button. */
- (void)presentRelativeToButton:(NSStatusBarButton *)button {
  if (self.activationObserver != nil) {
    [[NSNotificationCenter defaultCenter] removeObserver:self.activationObserver];
    self.activationObserver = nil;
  }
  if ([NSApp isActive]) {
    [self showRelativeToButton:button];
    return;
  }
  __weak CBPopover *weakSelf = self;
  __block id token = nil;
  token = [[NSNotificationCenter defaultCenter]
      addObserverForName:NSApplicationDidBecomeActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                (void)note;
                [weakSelf showIfWaitingOn:token relativeToButton:button];
              }];
  self.activationObserver = token;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(CB_ACTIVATION_FLOOR_S * (double)NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
                   [weakSelf showIfWaitingOn:token relativeToButton:button];
                 });
  [[NSRunningApplication currentApplication] activateWithOptions:NSApplicationActivateAllWindows];
}

/* The single door both of -presentRelativeToButton:'s paths call through. `token` is an
 * identity check, not a value read for its own sake: it is only ever this popover's
 * CURRENT wait if `self.activationObserver` still equals it, which is false the instant
 * either path has already fired (the first thing each does is nil the property out) or a
 * later click has superseded this one entirely. Whichever of the notification and the
 * floor arrives first wins and the other becomes a no-op against a property that has moved
 * on — which is also what makes the floor safe to leave scheduled rather than cancelled: a
 * `dispatch_after` block cannot be cancelled once queued, so letting the stale ones run and
 * fizzle here is cheaper than building a cancellation path for a check this short. */
- (void)showIfWaitingOn:(id)token relativeToButton:(NSStatusBarButton *)button {
  if (self.activationObserver != token) return;
  [[NSNotificationCenter defaultCenter] removeObserver:token];
  self.activationObserver = nil;
  [self showRelativeToButton:button];
}

/* Criterion 4's policy: nothing here calls -makeFirstResponder:. A stock NSButton that
 * AppKit is told is first responder draws itself filled, exactly as if it were the
 * window's default button — that is the "filled primary button" criterion 4 refuses, and
 * it does not matter which control it would have been, which is why the fix is to pick
 * none rather than to pick a different one. Left alone, the window's first responder stays
 * the window itself until the reader presses Tab, at which point AppKit hands focus to the
 * first control in the key view loop — which is criterion 3, satisfied by not fighting the
 * default. Showing the popover only after activation has actually landed (see
 * -presentRelativeToButton:) is what lets AppKit make this window key at all; a key-less
 * window has no key view loop to walk.
 *
 * A ceiling this policy does not touch and must not try to: Tab only reaches a BUTTON at
 * all when the reader has Full Keyboard Access turned on (System Settings › Keyboard);
 * with it off — the default — Tab still walks text fields and lists but skips buttons
 * entirely, which is macOS's own key-view-loop behaviour and not something this file
 * decides. A reviewer checking criterion 3 with Full Keyboard Access off will see Tab do
 * nothing here, and that is not this policy's bug to fix. */
- (void)showRelativeToButton:(NSStatusBarButton *)button {
  [self.popover showRelativeToRect:button.bounds ofView:button preferredEdge:NSRectEdgeMinY];
  /* Explicit, though NSPopover already makes its own window key on show once the app is
   * genuinely active (which -presentRelativeToButton: now guarantees it is by this point):
   * naming the decision rather than leaning on it as a side effect. Key, not first
   * responder — the window itself stays first responder, which is the other half of
   * criterion 4. */
  [self.popover.contentViewController.view.window makeKeyWindow];
}

/* The row/stack construction -rebuild presents on every open, factored out so
 * `--menubar --probe layout` (criterion 13) can force Auto Layout to resolve the SAME
 * views and read real frames back off them — a probe pinning a second copy of this
 * construction would be vacuous the moment the two drifted apart, so there is exactly
 * one place this popover's rows are built, and both callers run it.
 *
 * Sets self.glyphView/statusLine/toggle/stateWord/gearButton/forwardButton/rowURLs
 * exactly as -rebuild always has — a throwaway probe instance sets them on itself and
 * is discarded, never touching the real popover's own. Returns the fixed-width content
 * view; -rebuild wraps it in a view controller and hands it to the popover, and the
 * probe forces layout on it directly. */
- (NSView *)buildContentWithDisplay:(cb_display)display waiting:(cb_waiting)waiting {
  NSMutableArray<NSView *> *rows = [NSMutableArray array];
  NSMutableArray<NSString *> *urls = [NSMutableArray array];

  /* The status line: the phase glyph the menu bar is drawing at this same instant, the
   * phase in words, and the gear pinned right. The glyph is an NSImageView rather than a
   * button because it is not a control — and it is the one place a colour is named beyond
   * the captions: an image view has no text colour of its own for a template image to
   * inherit, so `labelColor` says out loud that this glyph belongs to the line beside it.
   * A semantic name, resolved by the system per appearance, never a value. */
  self.glyphView = [NSImageView imageViewWithImage:cb_glyph_image(display)];
  self.glyphView.contentTintColor = [NSColor labelColor];
  [self.glyphView setAccessibilityElement:NO];

  char status[64];
  cb_status_label(display, status, sizeof(status));
  self.statusLine = cb_caption([NSString stringWithUTF8String:status], NO);
  cb_fill_with(self.statusLine);

  self.gearButton = cb_icon_button(cb_icon_image(cb_gear_path()), @"Settings", self,
                                   @selector(pressSettings:));
  [rows addObject:cb_row(@[ self.glyphView, self.statusLine, self.gearButton ])];

  /* The control row. The switch's POSITION and the word beside it both report the STATE;
   * its accessibility label is the ACTION a press performs, in the widget's own spelling
   * ("Start pomodoro" / "Pause pomodoro" / "Resume pomodoro"), so the two surfaces say the
   * same sentence to a screen reader. */
  self.toggle = [[NSSwitch alloc] init];
  self.toggle.target = self;
  self.toggle.action = @selector(pressPrimary:);
  self.toggle.state = cb_switch_on(display) ? NSControlStateValueOn : NSControlStateValueOff;
  NSString *switch_word = [NSString stringWithUTF8String:cb_switch_label(cb_switch_action(display))];
  [self.toggle setAccessibilityLabel:[switch_word stringByAppendingString:@" pomodoro"]];

  self.stateWord = cb_caption([NSString stringWithUTF8String:cb_switch_state_word(display)], YES);
  cb_fill_with(self.stateWord);

  NSButton *restart = cb_icon_button(cb_icon_image(cb_restart_path()), @"Restart interval",
                                     self, @selector(pressRestart:));
  self.forwardButton = cb_icon_button(cb_icon_image(cb_forward_path()), @"Forward to next interval",
                                      self, @selector(pressForward:));
  [rows addObject:cb_row(@[ self.toggle, self.stateWord, restart, self.forwardButton ])];

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

  NSStackView *stack = [NSStackView stackViewWithViews:rows];
  stack.orientation = NSUserInterfaceLayoutOrientationVertical;
  stack.spacing = 6.0;
  stack.edgeInsets = NSEdgeInsetsMake(12.0, 14.0, 12.0, 14.0);
  stack.translatesAutoresizingMaskIntoConstraints = NO;

  /* Criteria 1-2: every row spans the panel's own content width, sharing one left edge
   * and one right edge. NOT what `stack.alignment` buys — its values (leading, trailing,
   * centerX, width) either align arranged subviews against EACH OTHER or, per
   * NSLayoutAttributeWidth specifically, make them equal-width to one another; none of
   * them pins a row's own edges to the STACK's. `alignment` used to be set to
   * NSLayoutAttributeWidth here on a comment claiming it made "every row the stack's
   * width" — measured, it did not: the rows kept their intrinsic width and floated at the
   * trailing edge, which is why the divider (an NSBox, the one arranged subview with no
   * intrinsic width of its own to keep) was the only row that looked right.
   *
   * Pinning each row's leading/trailing to the STACK's own anchors, offset by the exact
   * insets above, is what makes a row exactly as wide as the panel's content area
   * regardless of what its own arranged subviews would otherwise have hugged to — and
   * combined with cb_fill_with's hugging fix, the row's one loosely-hugging label is what
   * absorbs the difference between that fixed width and everything else in the row's own
   * intrinsic size. */
  CGFloat insetLeft = stack.edgeInsets.left;
  CGFloat insetRight = stack.edgeInsets.right;
  for (NSView *row in rows) {
    [NSLayoutConstraint activateConstraints:@[
      [row.leadingAnchor constraintEqualToAnchor:stack.leadingAnchor constant:insetLeft],
      [row.trailingAnchor constraintEqualToAnchor:stack.trailingAnchor constant:-insetRight],
    ]];
  }

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
  return content;
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

  NSView *content = [self buildContentWithDisplay:display waiting:waiting];

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

/* The tick's half of the popover: the glyph, two strings and the switch's position, and
 * nothing else. Called once a second from cb_tick — including while the popover is
 * TRACKING, which is the property the tick's NSRunLoopCommonModes registration exists to
 * buy. Rebuilding rows here is deliberately not done; see -rebuild.
 *
 * Every write is guarded by a comparison, which is not micro-optimisation: NSSwitch
 * ANIMATES a state change, so assigning the same state once a second would leave a control
 * that twitches at 1Hz, and re-assigning an identical string would fight a reader who has
 * the row selected. */
- (void)refresh:(cb_display)display {
  if (!self.popover.shown) return;
  self.glyphView.image = cb_glyph_image(display);

  char status[64];
  cb_status_label(display, status, sizeof(status));
  NSString *line = [NSString stringWithUTF8String:status];
  if (line != nil && ![self.statusLine.stringValue isEqualToString:line]) {
    self.statusLine.stringValue = line;
  }

  NSString *state = [NSString stringWithUTF8String:cb_switch_state_word(display)];
  if (state != nil && ![self.stateWord.stringValue isEqualToString:state]) {
    self.stateWord.stringValue = state;
  }

  NSControlStateValue on = cb_switch_on(display) ? NSControlStateValueOn : NSControlStateValueOff;
  if (self.toggle.state != on) self.toggle.state = on;
  NSString *word = [NSString stringWithUTF8String:cb_switch_label(cb_switch_action(display))];
  if (word != nil) [self.toggle setAccessibilityLabel:[word stringByAppendingString:@" pomodoro"]];
}

/* Derived at the moment of the press rather than read off the switch's own position: the
 * position is at most one tick old, and "at most one second stale" is not a thing to be
 * about a control that starts or stops a timer. Mirrors src/indexpage.mjs's own
 * `postPomodoro(pomodoroSwitchAction(pomodoroDoc.timer))`, which reads its cached document
 * for the same reason rather than its own control's state.
 *
 * The switch has already moved itself by the time this runs, and it is left alone: the
 * POST goes out on the poll queue with a fresh poll behind it, so the next tick either
 * confirms the new position or puts it back — which is the honest outcome when the daemon
 * refused, and the same arrangement the index page's widget has. */
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
  /* ADR 93: the tab this board is already open in comes forward, and a second one is
   * opened only when there is none. Identical to what a banner's click does, because it is
   * the same call into the same function (cb_surface_tab, bin/launcher.c) — a row and a
   * banner naming the same board must not behave differently.
   *
   * Off the main thread, unlike bin/notify.m's call, and that difference is deliberate:
   * surfacing can wait on a human (an Automation prompt is a dialog somebody has to
   * answer), and the thing this process would otherwise be blocking is a status item that
   * is still drawing a clock. bin/notify.m has nothing else to do while it waits and so
   * makes the same call inline. The open lands back on the main queue, where AppKit wants
   * it, and exactly one of the two happens per click.
   *
   * Its own serial queue, not cb_poll_queue and not a global one: an errand that can wait
   * twenty seconds on a human must not stall the poll behind it, and serial still means
   * two rapid clicks surface one board at a time rather than racing. */
  NSString *target = [url copy];
  static dispatch_queue_t surface_queue;
  static dispatch_once_t surface_once;
  dispatch_once(&surface_once, ^{
    surface_queue = dispatch_queue_create("io.github.jerrylui.claude-board.menubar.surface",
                                          DISPATCH_QUEUE_SERIAL);
  });
  dispatch_async(surface_queue, ^{
    if (cb_surface_tab([target UTF8String])) return;
    dispatch_async(dispatch_get_main_queue(), ^{
      cb_open_url([NSURL URLWithString:target]);
    });
  });
}

- (void)pressIndex:(id)sender {
  (void)sender;
  [self.popover performClose:nil];
  cb_open_url(cb_index_url(@""));
}

/* The gear's errand, and the whole of this file's settings story: the index page's
 * existing panel, opened on the fragment that scrolls it into view. Nothing is editable
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
   * that the status item is visible with this call omitted entirely, under the
   * LSBackgroundOnly plist that predates ADR.md entry 75's switch to LSUIElement, from a
   * shell and from launchd alike -- nothing rests on it, and Info.plist is not touched by
   * this feature for the same reason a rebuild is not free (a changed plist is a changed
   * bundle is a re-prompt for the Documents grant). */
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
   * bringing it back from the index page's settings has to work with no restart, and a
   * process that exited when hidden would leave nothing for the setting to reach. That
   * panel is the ONLY place this boolean is written now; this process only reads it. */
  cb_item.visible = d.hidden ? NO : YES;
  cb_item.button.image = cb_image(d);
  cb_item.button.title = d.countdown ? [NSString stringWithUTF8String:d.text] : @"";
  /* The popover's own second, if it is open. Two strings and no layout — see -refresh:. */
  [cb_popover refresh:d];

  /* The boundary re-fetch, and it is not optional: criterion 1 pins this item to within a
   * second of the index widget, and the widget re-fetches the moment its own countdown
   * reaches zero (tickPomodoro). Without this, an interval that ended would sit at 00:00
   * with an empty ring for up to CB_POLL_S while the widget had already moved on. Debounced
   * to one fetch per crossing, the poll being the backstop if that one is lost.
   *
   * `d.phase != CB_IDLE` is cb_derive's spelling of "there is a timer": the protocol has
   * no idle phase, so a running timer always derives to one of the other three.
   *
   * ONTO cb_poll_queue, like every other request this process makes, and not onto a global
   * concurrent queue. That was the one dispatch in this file that opted out of the serial
   * ordering cb_poll_queue exists for, and it opted out at the exact moment a reader is
   * most likely to be pressing something: the countdown has just hit zero, so the popover
   * is open and Restart is under the cursor. A concurrent GET can be in flight while the
   * Restart POST lands, finish after it, and write the PRE-restart document over the fresh
   * one — the item then shows 00:00 again until the next poll, and a second press "fixes"
   * it. Serial makes that ordering rather than a hope, which is cb_dispatch_action's own
   * reasoning applied to the one caller that had been left out of it. */
  if (d.answered && d.phase != CB_IDLE && !d.paused && d.remaining_s <= 0 && !zero_fetched &&
      cb_poll_queue != nil) {
    [cb_state_lock lock];
    cb_state_zero_fetched = 1;
    [cb_state_lock unlock];
    dispatch_async(cb_poll_queue, ^{ cb_poll_once(); });
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
     * measured) — which would silently stop the poll for as long as the reader kept the
     * popover open. DISPATCH_TIME_NOW as the start, so the first fetch goes out immediately
     * and the item can appear as soon as the daemon is up; a one-second leeway, because
     * nothing here needs the wakeup to be punctual.
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

    /* Ticket 02: the daemon-wide stream, opened BESIDE the poll above rather than instead
     * of it — the poll's own timer, queue and cadence are all untouched by this line, and
     * everything a stream push does from here on is dispatch a fresh cb_poll_once onto the
     * SAME cb_poll_queue the timer above and every popover action already share. `nil`:
     * nothing in the real run loop is waiting to be told the subscription connected. */
    cb_stream_start(nil);

    /* NSRunLoopCommonModes, not the default mode, and this is the trap QUIRKS.md wrote
     * down after measuring it: menu and popover tracking run the loop in
     * NSEventTrackingRunLoopMode, which a default-mode timer never reaches. A countdown
     * that froze the moment the popover opened — the one moment a reader is looking
     * straight at it — would be the most visible bug this file could ship. */
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
     * DISPATCH an event, so the item would draw and the popover's clicks would go nowhere.
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
 * `reset` IS NOT HERE, and neither is anything that writes a setting (see
 * CB_ACTION_PATHS). Both are refused like any other unrecognised word, which is what lets
 * a check assert the refusal behaviourally as well as by reading this file. */
static const struct { const char *word; cb_action action; } CB_PROBE_ACTIONS[] = {
  { "start", CB_ACTION_START },
  { "pause", CB_ACTION_PAUSE },
  { "resume", CB_ACTION_RESUME },
  { "forward", CB_ACTION_FORWARD },
  { "restart", CB_ACTION_RESTART },
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
 * Eight optional words follow, and they are the seam's eight shapes:
 *
 *   <action>            one of CB_PROBE_ACTIONS, POSTed before the report. This is what
 *                       makes "every control takes effect" checkable at all: a check can
 *                       start, pause, resume, forward and restart the daemon's real timer
 *                       through the same cb_perform the popover's controls call, and read
 *                       the daemon's own state back afterwards. An unrecognised word — the
 *                       reset action most of all — is refused with a nonzero exit and posts
 *                       nothing.
 *   url <candidate>     print whether cb_is_board_url would let a row open that URL, and
 *                       exit. The one way to check the refusal without a daemon that can be
 *                       made to emit a bad URL.
 *   open <candidate>    ADR 93. Print what a click on a waiting row for that URL would do —
 *                       `raised` (a browser was already showing that board and its tab was
 *                       brought forward, so nothing is opened), `opened` (nothing was, so
 *                       the row opens it), or `refused` (cb_is_board_url said no, so the row
 *                       does neither). The decision is made by the SAME cb_surface_tab call
 *                       -pressRow: makes, against the real browsers on this machine; the
 *                       open itself is the one step this seam stops short of, since it is
 *                       AppKit and would put a browser tab on the reader's screen on every
 *                       suite run. See the branch itself for the whole of that reasoning.
 *   icons               print each popover icon's bounding box in the SVG's own 24-unit
 *                       space, and exit. The path-data walker above turns a dozen
 *                       elliptical arcs into a drawing nothing headless can look at, and
 *                       its realistic failures are all visible in a bounding box: a command
 *                       it does not understand drops a subpath and shrinks the box, and an
 *                       arc solved on the wrong side or swept the wrong way round moves the
 *                       ink somewhere it does not belong (measured: either one takes the
 *                       restart icon's width from 20 units to 6). Paths only: no image, no
 *                       view, no application.
 *   stream <seconds>    hold the daemon-wide `GET /api/events` stream open (`cb_stream_probe`
 *                       above) and report the first pushed event, or a timeout after
 *                       `seconds` (default CB_STREAM_DEFAULT_TIMEOUT_S). The one shape here
 *                       that does not exit at once: it prints `stream=connected` the moment
 *                       the subscription is live, which is a check's cue that it may now
 *                       make whatever daemon-side change it wants this probe to observe.
 *                       Ticket 01's seam: proves the RAW connection carries a push.
 *   live <seconds>      ticket 02's own widening of the seam above. `stream` proves a push
 *                       arrives on the wire; this proves a push reaches the exact state
 *                       cb_tick draws from — cb_state_*, updated through the real
 *                       cb_stream_start / cb_poll_once pair the run loop wires together,
 *                       with no AppKit anywhere near it and no periodic poll armed to have
 *                       found the same answer some other way. See cb_menubar_probe_live
 *                       below for the full shape of what it prints.
 *   run <seconds>       ticket 03's own widening, and the mirror image of `live`: where
 *                       `live` arms the stream ALONE so a report can only be explained by a
 *                       push, this arms BOTH pieces cb_menubar's real run loop arms — the
 *                       periodic poll and the stream, side by side, exactly as shipped.
 *                       Criterion 6 is a claim about what happens when the stream genuinely
 *                       cannot be reached, and the only way to prove that without reasoning
 *                       about the code is to point this at something that answers
 *                       `/api/pomodoro` but refuses or never opens `/api/events`, and watch
 *                       the item update anyway. See cb_menubar_probe_run below.
 *   layout               criterion 13. Builds -rebuild's OWN row/stack construction (via
 *                       -buildContentWithDisplay:waiting:, so this is never a second copy
 *                       that could drift from what ships), asks it to size itself, forces
 *                       Auto Layout to resolve it, and prints every arranged subview's
 *                       resolved frame — no NSApplication, no window, nothing shown
 *                       anywhere; building views and forcing layout needs neither. See
 *                       cb_menubar_probe_layout below for the exact frames it prints.
 *
 * Output. The first line is space-separated `key=value` with every value a bare word, so a
 * check can split it without a parser; `text` is the countdown the derivation produced
 * whether or not it would be shown (`countdown` is the flag that says whether it reaches
 * the button) and is the word `none` when there is no interval to count. The lines after
 * it carry the popover's own words, one per line, `key=` and then the rest of the line
 * verbatim — because a row label contains spaces and a middle dot, and quoting them would
 * be a parser this seam does not need. Exits 0 even when the daemon never answered: the
 * errand was to report, and it reported. */

/* `--menubar --probe live <seconds>`, the body of the `live` shape documented above.
 *
 * Sets up exactly the two pieces of shared state cb_menubar's real run loop sets up before
 * it ever touches AppKit — `cb_state_lock` and `cb_poll_queue` — starts the SAME
 * `cb_stream_start` the real run loop calls, and then waits. No `dispatch_source` timer is
 * armed here, unlike cb_menubar: with nothing else able to call `cb_poll_once`, the only
 * way `cb_state_*` can change during the wait is a push landing on the stream and
 * `cb_stream_handle_event` dispatching a re-poll — so a report that differs from the
 * unanswered defaults is proof the push, and only the push, did it.
 *
 * Two lines on stdout, mirroring `cb_stream_probe`'s own shape:
 *
 *   stream=connected | stream=refused   the subscription's own headers, exactly as
 *                                       `--probe stream` reports them — a caller's cue
 *                                       that it may now make the daemon-side change it
 *                                       wants this probe to observe. Nothing further is
 *                                       printed on a refusal: there is no wait to report.
 *   live=pushed | live=timeout          did a push land inside `seconds` (default
 *                                       CB_STREAM_DEFAULT_TIMEOUT_S)
 *
 * followed by the plain probe's own report line and waiting-section lines — cb_state_*
 * read back through cb_current_display and cb_state_waiting, the exact fields cb_tick
 * would draw from and -rebuild would list. */
static void cb_menubar_probe_live(double timeoutSeconds) {
  cb_state_lock = [[NSLock alloc] init];
  cb_defaults(&cb_state_timer, &cb_state_settings);
  cb_poll_queue =
      dispatch_queue_create("io.github.jerrylui.claude-board.menubar.probe-live", DISPATCH_QUEUE_SERIAL);
  cb_poll_completed_sem = dispatch_semaphore_create(0);

  dispatch_semaphore_t connectedSem = dispatch_semaphore_create(0);
  cb_stream_start(connectedSem);

  int64_t headersWaitNs = (int64_t)(CB_REQUEST_TIMEOUT_S * (double)NSEC_PER_SEC);
  BOOL connected = dispatch_semaphore_wait(connectedSem, dispatch_time(DISPATCH_TIME_NOW, headersWaitNs)) == 0;
  printf(connected ? "stream=connected\n" : "stream=refused\n");
  fflush(stdout);
  if (!connected) return;

  int64_t pushWaitNs = (int64_t)(timeoutSeconds * (double)NSEC_PER_SEC);
  BOOL pushed = dispatch_semaphore_wait(cb_poll_completed_sem, dispatch_time(DISPATCH_TIME_NOW, pushWaitNs)) == 0;
  printf("live=%s\n", pushed ? "pushed" : "timeout");

  cb_display d;
  if (!cb_current_display(&d, NULL)) memset(&d, 0, sizeof(d));
  static const char *const PHASES[] = { "idle", "work", "break", "longBreak" };
  printf("phase=%s paused=%s remaining=%ld fraction=%.3f countdown=%s text=%s hidden=%s answered=%s\n",
         PHASES[d.phase], d.paused ? "yes" : "no", d.remaining_s, d.fraction,
         d.countdown ? "yes" : "no", d.text[0] ? d.text : "none", d.hidden ? "yes" : "no",
         d.answered ? "yes" : "no");

  [cb_state_lock lock];
  cb_waiting waiting = cb_state_waiting;
  [cb_state_lock unlock];
  printf("waiting=%d total=%d more=%d\n", waiting.count, waiting.total, waiting.more);
  for (int i = 0; i < waiting.count; i++) printf("row=%s\n", waiting.rows[i].label);
  fflush(stdout);
}

/* `--menubar --probe run <seconds>`, the body of the `run` shape documented above. Ticket
 * 03's own widening, and the mirror image of `cb_menubar_probe_live` above: that mode arms
 * the stream ALONE so a report can only be explained by a push; this arms the SAME two
 * pieces cb_menubar's real run loop arms — the periodic `dispatch_source` poll (identical to
 * the one cb_menubar creates, and to the one test/check-menubar-client.mjs's own structural
 * pin asserts is untouched) and the stream, side by side.
 *
 * Waits for exactly ONE successful poll rather than the periodic cadence itself, which would
 * cost a real CB_POLL_S per observation: the poll is armed at DISPATCH_TIME_NOW exactly as
 * cb_menubar's is, so seeing that first one land already owes nothing to the stream — a
 * caller wanting to prove criterion 6 points this at something that answers `/api/pomodoro`
 * but refuses or never opens `/api/events` (a stand-in, a proxy, an old daemon) and reads
 * `answered=yes` back regardless.
 *
 * One line ahead of the plain probe's own report: `run=polled` or `run=timeout`. No
 * `stream=` line here on purpose — unlike `live`, this mode's whole point is that the
 * stream's own fate must not decide what gets printed. */
static void cb_menubar_probe_run(double timeoutSeconds) {
  cb_state_lock = [[NSLock alloc] init];
  cb_defaults(&cb_state_timer, &cb_state_settings);
  cb_poll_queue =
      dispatch_queue_create("io.github.jerrylui.claude-board.menubar.probe-run", DISPATCH_QUEUE_SERIAL);
  cb_poll_completed_sem = dispatch_semaphore_create(0);

  dispatch_source_t poll = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, cb_poll_queue);
  dispatch_source_set_timer(poll, DISPATCH_TIME_NOW, (uint64_t)(CB_POLL_S * (double)NSEC_PER_SEC),
                            (uint64_t)NSEC_PER_SEC);
  dispatch_source_set_event_handler(poll, ^{ cb_poll_once(); });
  dispatch_resume(poll);

  cb_stream_start(nil);

  int64_t waitNs = (int64_t)(timeoutSeconds * (double)NSEC_PER_SEC);
  BOOL polled = dispatch_semaphore_wait(cb_poll_completed_sem, dispatch_time(DISPATCH_TIME_NOW, waitNs)) == 0;
  dispatch_source_cancel(poll);
  printf("run=%s\n", polled ? "polled" : "timeout");

  cb_display d;
  if (!cb_current_display(&d, NULL)) memset(&d, 0, sizeof(d));
  static const char *const PHASES[] = { "idle", "work", "break", "longBreak" };
  printf("phase=%s paused=%s remaining=%ld fraction=%.3f countdown=%s text=%s hidden=%s answered=%s\n",
         PHASES[d.phase], d.paused ? "yes" : "no", d.remaining_s, d.fraction,
         d.countdown ? "yes" : "no", d.text[0] ? d.text : "none", d.hidden ? "yes" : "no",
         d.answered ? "yes" : "no");

  [cb_state_lock lock];
  cb_waiting waiting = cb_state_waiting;
  [cb_state_lock unlock];
  printf("waiting=%d total=%d more=%d\n", waiting.count, waiting.total, waiting.more);
  for (int i = 0; i < waiting.count; i++) printf("row=%s\n", waiting.rows[i].label);
  fflush(stdout);
}

/* Which top-level row (an index into `stack.arrangedSubviews`) holds `target` — itself, if
 * `target` IS a top-level row, or whichever row's OWN arranged subviews contain it
 * otherwise. -1 if `target` is nil or genuinely not anywhere in `stack`.
 *
 * What this buys a check that `frame=` alone cannot: a control's frame is relative to its
 * OWN superview (an ordinary NSView fact), so two controls sitting in different rows can
 * report identical-looking coordinates by coincidence — every row is the same width, so
 * "flush with my row's own trailing edge" is true of the gear whichever row it is
 * mistakenly IN. A row INDEX is the one fact that is not relative to anything else that
 * could have moved, which is what makes it possible to assert "the gear is in the STATUS
 * row, specifically" rather than "the gear is in A row, and that row is well-formed". */
static NSInteger cb_row_index_of(NSStackView *stack, NSView *target) {
  if (target == nil) return -1;
  for (NSUInteger i = 0; i < stack.arrangedSubviews.count; i++) {
    NSView *row = stack.arrangedSubviews[i];
    if (row == target) return (NSInteger)i;
    if ([row isKindOfClass:[NSStackView class]] &&
        [((NSStackView *)row).arrangedSubviews indexOfObjectIdenticalTo:target] != NSNotFound) {
      return (NSInteger)i;
    }
  }
  return -1;
}

/* `--menubar --probe layout`, criterion 13's own seam. One fetch (the plain probe's own
 * shape, not cb_state_* — there is no poll loop here and none is wanted), one throwaway
 * CBPopover instance whose ONLY job is to hold the outputs of
 * -buildContentWithDisplay:waiting: — the exact method -rebuild calls — and one forced
 * layout pass with no window, no application and nothing on screen.
 *
 * `-fittingSize` is what stands in for "the popover is about to show": NSPopover would
 * ordinarily size its content view from Auto Layout the moment it appears, and a detached
 * `content` left at its constructor's placeholder frame (CB_POPOVER_W x 10, -rebuild's own
 * literal — tall enough for nothing) never receives that sizing pass on its own. Asking
 * for `fittingSize` and writing it back is the same "measure without a window" idiom
 * QUIRKS.md's own diagnosis of this fault already used to produce the very numbers this
 * ticket was handed.
 *
 * One `frame=` line per top-level row (`row0`, `row1`, … in stack order — the status row,
 * the control row, the separator, the waiting caption, then each waiting row and the
 * overflow row if either is present), which is what lets a check assert "every row shares
 * one left edge and one right edge" — criterion 1's "spans the panel" and criterion 13's
 * "a row stops spanning the panel" — generically, over however many rows this daemon's
 * waiting list produced, with no row's identity hardcoded. Each carries a trailing
 * `class=` naming the row's own Objective-C class (`NSStackView` for the status/control
 * rows, `NSBox` for the divider, `NSTextField` for the waiting caption, `NSButton` for a
 * waiting row or the overflow row) — the one fact a resolved frame alone cannot carry —
 * which is what lets a check pin the DOCUMENTED sequence of row KINDS, not merely that
 * whatever sequence exists agrees with itself.
 *
 * Named `frame=` lines for the specific controls criteria 2 and 3 are about — the phase
 * glyph, the gear, the switch, the state word and the forward button — follow, read off
 * the same instance's own properties rather than re-found by walking the tree a second
 * time. A `rowindex=` line for each of those same controls names which top-level row
 * (cb_row_index_of, above) actually holds it — the fact that tells "the gear is flush
 * with the STATUS row's own trailing edge" apart from "the gear is flush with SOME row's
 * trailing edge, whichever row that happens to be".
 *
 * A trailing `status=` line is the same string cb_status_label produced for THIS build's
 * row set, so a check proving criterion 3 against the longest string that line ever shows
 * can confirm it actually got that string from this SAME call, rather than trusting a
 * second, separate probe to have hit the same daemon state. */
static void cb_menubar_probe_layout(void) {
  cb_timer timer;
  cb_settings settings;
  double daemon_now = 0.0;
  int cycle = 0;
  int answered = cb_fetch(&timer, &settings, &daemon_now, &cycle) ? 1 : 0;
  cb_display display = cb_derive(answered, &timer, &settings, daemon_now, cycle);

  cb_waiting waiting;
  memset(&waiting, 0, sizeof(waiting));
  (void)cb_fetch_waiting(&waiting);

  CBPopover *popover = [[CBPopover alloc] init];
  NSView *content = [popover buildContentWithDisplay:display waiting:waiting];
  NSSize fit = content.fittingSize;
  content.frame = NSMakeRect(0.0, 0.0, fit.width, fit.height);
  [content layoutSubtreeIfNeeded];

  NSStackView *stack = (NSStackView *)content.subviews.firstObject;
  for (NSUInteger i = 0; i < stack.arrangedSubviews.count; i++) {
    NSView *row = stack.arrangedSubviews[i];
    NSRect frame = row.frame;
    printf("frame=row%lu x=%.2f y=%.2f w=%.2f h=%.2f class=%s\n", (unsigned long)i,
           frame.origin.x, frame.origin.y, frame.size.width, frame.size.height,
           NSStringFromClass([row class]).UTF8String);
  }
  const struct { const char *name; NSView *view; } named[] = {
    { "glyph", popover.glyphView },
    { "statusline", popover.statusLine },
    { "gear", popover.gearButton },
    { "toggle", popover.toggle },
    { "stateword", popover.stateWord },
    { "forward", popover.forwardButton },
  };
  for (size_t i = 0; i < sizeof(named) / sizeof(named[0]); i++) {
    NSRect frame = named[i].view.frame;
    printf("frame=%s x=%.2f y=%.2f w=%.2f h=%.2f\n", named[i].name,
           frame.origin.x, frame.origin.y, frame.size.width, frame.size.height);
  }
  for (size_t i = 0; i < sizeof(named) / sizeof(named[0]); i++) {
    printf("rowindex=%s %ld\n", named[i].name, (long)cb_row_index_of(stack, named[i].view));
  }
  /* The status line's own text alongside its frames — so a check proving criterion 3
   * against the longest string this line ever shows can confirm it actually got that
   * string from this SAME probe call, rather than trusting a second, separate invocation
   * to have hit the same daemon state. */
  char status[64];
  cb_status_label(display, status, sizeof(status));
  printf("status=%s\n", status);
  fflush(stdout);
}

int cb_menubar_probe(const char *word, const char *argument) {
  @autoreleasepool {
    if (word != NULL && strcmp(word, "url") == 0) {
      /* The validator, alone, against one candidate — no request, no daemon, no state. */
      int ok = argument != NULL && cb_is_board_url(argument, cb_port());
      printf("url=%s\n", ok ? "ok" : "refused");
      fflush(stdout);
      return 0;
    }
    if (word != NULL && strcmp(word, "open") == 0) {
      /* ADR 93's decision, alone: would this click raise a tab, or open one? Same two
       * steps -pressRow: takes and in the same order — the validator first, because a URL
       * that may not be opened may not be asked about either, and then cb_surface_tab.
       *
       * What this deliberately does NOT do is perform the fallback open. `opened` is the
       * word for it because it is the branch on which the two real call sites open, and
       * the seam stops one line short of doing so on purpose: the fallback is
       * +[NSWorkspace openURL:], which would put a real browser tab on the reader's screen
       * every time the check suite ran. So the DECISION is behavioural here and the open
       * that follows from it is pinned structurally in test/check-menubar-client.mjs —
       * "the AppKit half cannot be checked" applies to this line as much as to a popover.
       *
       * `refused` is cb_is_board_url's answer, printed under this word too rather than
       * only under `url`, so a check can tell "would not be opened at all" apart from
       * "would be opened fresh" without running two probes. */
      if (argument == NULL || !cb_is_board_url(argument, cb_port())) {
        printf("open=refused\n");
        fflush(stdout);
        return 0;
      }
      printf("open=%s\n", cb_surface_tab(argument) ? "raised" : "opened");
      fflush(stdout);
      return 0;
    }
    if (word != NULL && strcmp(word, "icons") == 0) {
      /* Reported in SVG units rather than points, so the numbers a check asserts are the
       * ones a reader can measure off src/pomodoro-widget.mjs's own viewBox. `%.2f` and not
       * more: a NaN prints as `nan` at any precision, and nothing here is asserted tighter
       * than a tenth of a unit. */
      const struct { const char *name; NSBezierPath *path; } icons[] = {
        { "gear", cb_gear_path() },
        { "restart", cb_restart_path() },
        { "forward", cb_forward_path() },
      };
      for (size_t i = 0; i < sizeof(icons) / sizeof(icons[0]); i++) {
        NSRect box = [icons[i].path bounds];
        printf("icon=%s elements=%ld x=%.2f y=%.2f w=%.2f h=%.2f\n", icons[i].name,
               (long)[icons[i].path elementCount], box.origin.x, box.origin.y,
               box.size.width, box.size.height);
      }
      fflush(stdout);
      return 0;
    }
    if (word != NULL && strcmp(word, "layout") == 0) {
      cb_menubar_probe_layout();
      return 0;
    }
    if (word != NULL && strcmp(word, "stream") == 0) {
      double timeoutSeconds = CB_STREAM_DEFAULT_TIMEOUT_S;
      if (argument != NULL) {
        double parsed = atof(argument);
        if (parsed > 0.0) timeoutSeconds = parsed;
      }
      cb_stream_probe(timeoutSeconds);
      return 0;
    }
    if (word != NULL && strcmp(word, "live") == 0) {
      double timeoutSeconds = CB_STREAM_DEFAULT_TIMEOUT_S;
      if (argument != NULL) {
        double parsed = atof(argument);
        if (parsed > 0.0) timeoutSeconds = parsed;
      }
      cb_menubar_probe_live(timeoutSeconds);
      return 0;
    }
    if (word != NULL && strcmp(word, "run") == 0) {
      double timeoutSeconds = CB_STREAM_DEFAULT_TIMEOUT_S;
      if (argument != NULL) {
        double parsed = atof(argument);
        if (parsed > 0.0) timeoutSeconds = parsed;
      }
      cb_menubar_probe_run(timeoutSeconds);
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
    int cycle = 0;
    int answered = cb_fetch(&timer, &settings, &daemon_now, &cycle) ? 1 : 0;
    cb_display d = cb_derive(answered, &timer, &settings, daemon_now, cycle);

    static const char *const PHASES[] = { "idle", "work", "break", "longBreak" };
    /* `ring` and `mark` are the GLYPH, reported rather than drawn. The paint cannot be
     * checked, so ADR 84's vocabulary is asserted here instead: that a paused Timer draws
     * two bars and no ring in every phase, that nothing else draws those bars, and that a
     * short break and a long break report the same pair. */
    static const char *const MARKS[] = { "none", "rest", "paused" };
    /* `primary` is the ACTION word (the switch's accessibility label), `stateword` is the
     * state the switch is IN (what the reader sees beside it). Both are printed because
     * they are different words on purpose, and because "the popover says paused exactly
     * once" is only checkable if every word the popover shows is reported somewhere. */
    printf("phase=%s paused=%s remaining=%ld fraction=%.3f countdown=%s text=%s hidden=%s "
           "answered=%s primary=%s stateword=%s ring=%s mark=%s\n",
           PHASES[d.phase], d.paused ? "yes" : "no", d.remaining_s, d.fraction,
           d.countdown ? "yes" : "no", d.text[0] ? d.text : "none", d.hidden ? "yes" : "no",
           d.answered ? "yes" : "no", cb_switch_label(cb_switch_action(d)),
           cb_switch_state_word(d), d.ring ? "yes" : "no", MARKS[d.mark]);

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
