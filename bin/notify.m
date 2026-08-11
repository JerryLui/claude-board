/* The pomodoro boundary notification, posted from inside claude-board.app so that
 * Notification Center attributes it to claude-board rather than to Script Editor.
 *
 * Why this file exists at all, given src/notify.mjs already posted notifications: a
 * notification's name, its icon, and its row in System Settings > Notifications all come
 * from the bundle of the process that posts it, and nothing else can override them. The
 * daemon is `node`, which has no bundle, so it used to shell out to `osascript` — whose
 * bundle is Script Editor's, giving every pomodoro boundary Script Editor's name and
 * Script Editor's icon. It also gave the reader no way to make the notification persist:
 * "stays on screen until dismissed" is the Alerts style, which macOS offers per app, and
 * the app it was being offered for was Script Editor. Posting from this bundle fixes all
 * three at once — see ADR.md entry 19.
 *
 * This is compiled INTO the launcher binary (Contents/MacOS/claude-board), not into a
 * second executable beside it, and that is load-bearing rather than tidy:
 * UNUserNotificationCenter refuses outright — "Notifications are not allowed for this
 * application" — for a process that is not the bundle's own CFBundleExecutable, even when
 * that process sits inside Contents/MacOS of a correctly signed bundle. QUIRKS.md
 * ("A bundle's notification identity belongs to CFBundleExecutable") records the
 * measurement. So `claude-board --notify <phase>` is a mode of the launcher rather than a
 * helper next to it, and bin/launcher.c's fork-and-exec path never runs a line of this.
 *
 * Nothing here is reachable from the daemon-supervising path: cb_notify is called only
 * after main() has matched --notify in argv, which is a mode launchd never uses. The
 * ObjC runtime and both frameworks are still linked into the supervising process, which
 * costs a dyld load and nothing else — the child does no work between fork() and
 * execve() beyond resetting signals, so there is no ObjC state for a fork to be unsafe
 * about.
 */
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <signal.h>
#include <string.h>

/* --- The click-serving mode -----------------------------------------------------
 *
 * ADR.md entry 57. A banner for a stranded round is clickable, and serving that click
 * means this process cannot post and exit: the notification's delegate is only ever
 * called on a running instance of the app that posted it. So the round row's mode
 * registers an action category, sets a delegate, and stays alive for a bounded time --
 * minutes, where every other mode here lives for milliseconds -- which is what makes
 * everything below this line necessary and nothing above it different.
 *
 * AppKit, which ADR.md entry 72 admits for the status item and entry 57 narrows for
 * exactly this: a process that has not become an NSApplication is not a running app as
 * far as the notification service is concerned, so a click would launch a SECOND copy
 * of this binary -- and this binary with no argv is the daemon supervisor, which would
 * fork a second node against a port already bound. Accessory, not Regular: no Dock
 * icon, no menu bar, nothing on screen, still a running app. Entered only from the
 * click-serving branch; the supervising path in bin/launcher.c reaches none of this and
 * links AppKit the same way it already links Foundation, for a dyld load and nothing
 * else.
 *
 * NOT MEASURED, and stated as such because every other notification fact in this
 * codebase was measured first (QUIRKS.md's "macOS notifications and sound"): whether the
 * delegate callback also arrives without the NSApplication above, and how the click
 * behaves when this process has been killed between post and click. What IS known and
 * designed around is the second case's consequence -- a banner whose server is gone is a
 * banner whose click has to launch something -- which is why every exit path below
 * withdraws the notification first. */
static NSString *const kRoundCategory = @"claude-board.round";
static NSString *const kOpenBoardAction = @"claude-board.open-board";

/* bin/launcher.c's own tab surfacer (ADR.md entry 93), compiled into this same binary and
 * declared here on exactly the footing cb_notify is declared over there: one definition,
 * one build, a one-argument signature checkable against the other file by eye. It answers
 * 1 only when it raised an already-open tab on this board, in which case this process must
 * open NOTHING. Everything else -- no scriptable browser running, no tab on this board, no
 * osascript, a script that failed or outran its budget -- is 0 and the plain open below.
 * The board URL has already passed bin/launcher.c's cb_is_board_url before it reached this
 * file at all, which is what makes it safe to splice into a script over there.
 *
 * The same function serves bin/menubar.m's waiting rows, which open the same board URLs by
 * the same rule -- one answer to "is this board already open" rather than one per surface. */
extern int cb_surface_tab(const char *board_url);

/* Set from a signal handler, read only by the run loop below. `sig_atomic_t` and a plain
 * store are the whole of what a handler may safely do; the loop polls it once a second,
 * which is the price of not carrying a dispatch source for one boolean.
 *
 * The fire-and-exit modes never needed this: they live for milliseconds and default
 * dispositions are correct for them. A process that lives for the length of a round's
 * wait is one the daemon must be able to stop cleanly, and one launchd will signal
 * when the whole job goes down. */
static volatile sig_atomic_t stop_requested = 0;

static void cb_stop(int sig) {
  (void)sig;
  stop_requested = 1;
}

static void install_stop_handlers(void) {
  /* The same set bin/launcher.c forwards, and for the same reason: launchd stops a job
   * with SIGTERM, the daemon kills this child with SIGTERM, and a terminal sends the
   * other two when someone runs this by hand. SIGKILL is absent because it cannot be
   * caught -- and a SIGKILLed process leaves its banner in Notification Center, which is
   * the one case the deadline backstop cannot clean up either. */
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

/* A moment of run loop, because the withdrawal below is asynchronous and takes no
 * completion handler: returning straight out of cb_notify on top of it is how it gets
 * dropped on the floor. */
static void flush_run_loop(void) {
  NSDate *until = [NSDate dateWithTimeIntervalSinceNow:0.25];
  while ([until timeIntervalSinceNow] > 0) {
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                             beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
}

/* Take back this process's own notification -- pending and delivered both, by the one
 * identifier it posted under. Pending as well as delivered because a request handed over
 * but not yet on screen is the state a signal arriving mid-post leaves behind, and
 * withdrawing only what is already delivered would let that one through to become the
 * un-served banner this whole exercise is about. Nothing else in Notification Center is
 * reachable from here: the identifier is a UUID minted for this post.
 *
 * Two passes, either side of a flush of the run loop, because the withdrawal and the
 * delivery are racing: a stop can land in the microseconds between the request being
 * accepted and the banner appearing, and a withdrawal issued before that delivery does
 * not cover it. The second pass is what catches it, and withdrawing something already
 * gone is a no-op.
 *
 * One function rather than a sequence each exit path spells out for itself. Spelled out,
 * one of the paths got half of it -- withdraw, flush, return -- which is exactly the race
 * above left open on exactly the path most likely to hit it. There is no way to call
 * this one wrong. */
static void withdraw_own_notification(UNUserNotificationCenter *center, NSString *identifier) {
  for (int pass = 0; pass < 2; pass++) {
    [center removePendingNotificationRequestsWithIdentifiers:@[ identifier ]];
    [center removeDeliveredNotificationsWithIdentifiers:@[ identifier ]];
    flush_run_loop();
  }
}

/* The one click this process exists to serve. Two flags rather than one, because the
 * open is itself asynchronous: `clicked` says the reviewer acted, `served` says the board
 * is in front of them -- LaunchServices has answered, or (ADR.md entry 93) a browser
 * already showing it raised its own tab, which is synchronous and sets this on the spot --
 * and the loop below waits a little longer for the second so a click landing a second
 * before the deadline still opens the board. */
@interface CBRoundDelegate : NSObject <UNUserNotificationCenterDelegate>
@property(nonatomic, copy) NSString *boardURL;
@property(nonatomic, assign) BOOL clicked;
@property(nonatomic, assign) BOOL served;
@end

@implementation CBRoundDelegate

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
  (void)center;
  (void)notification;
  /* Without this, a notification posted while its own app is frontmost is delivered
   * silently to Notification Center and never banners. This process should never be
   * frontmost (Accessory, and it opens no window), so this is the belt to that braces:
   * the banner is the entire product here, and losing it to an activation state nothing
   * in this file controls would be a silent failure of criteria 1 to 3. */
  completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
             withCompletionHandler:(void (^)(void))completionHandler {
  (void)center;
  self.clicked = YES;
  BOOL wantsBoard = [response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]
                 || [response.actionIdentifier isEqualToString:kOpenBoardAction];
  NSURL *url = wantsBoard ? [NSURL URLWithString:self.boardURL] : nil;
  if (url == nil) {
    /* A dismiss, or a URL NSURL will not parse at all -- bin/launcher.c's cb_is_board_url
     * has already refused everything that could make the second case interesting. Either
     * way the errand is over. */
    self.served = YES;
    completionHandler();
    return;
  }
  /* Handed back BEFORE the errand rather than after it, which is new with entry 93 and is
   * the reason: surfacing a tab can wait on a human (an Automation prompt), and the block
   * below is Notification Center's own "you may stop tracking this response", not this
   * process's "the board is open". Holding it for twenty seconds to say something the
   * system never asked to be told is how a click gets reported undelivered. `served` is
   * the flag that actually gates this process's exit, and nothing touches it yet. */
  completionHandler();

  /* The tab this board is already open in comes forward, and nothing new is opened
   * (ADR.md entry 93). Entry 57 left this to the browser -- and every browser answers it
   * with a second tab, so a reviewer clicking a banner for the board already in front of
   * them got a duplicate. The URL is unchanged by it: still the plain board URL, still
   * nothing only this process could have minted, because what a scriptable browser is
   * asked for is a tab already showing that page.
   *
   * Blocking, on the delegate's own thread, and that is the right shape HERE specifically:
   * this process exists to serve this one click and has nothing else left to do while it
   * waits. bin/menubar.m makes the same call off the main thread instead, because the
   * thing it would otherwise block is a live status item. */
  if (cb_surface_tab([self.boardURL UTF8String])) {
    self.served = YES;
    return;
  }
  /* Nothing was showing it, so the default browser opens it, and the browser's own
   * long-lived session is what authorizes the page (ADR.md entry 57): no credential
   * travels with this URL, and a browser holding none lands on the refusal page
   * src/render.mjs already renders, naming the recovery command to run. This is also
   * where an unscriptable browser (Firefox) lands every time, keeping entry 57's
   * duplicate, which entry 93 accepts. */
  [[NSWorkspace sharedWorkspace] openURL:url
                           configuration:[NSWorkspaceOpenConfiguration configuration]
                       completionHandler:^(NSRunningApplication *app, NSError *error) {
    (void)app;
    if (error) {
      fprintf(stderr, "claude-board: could not open the board: %s\n",
              [[error localizedDescription] UTF8String]);
    }
    self.served = YES;
  }];
}

@end

/* Matched by hand against the extern declaration in bin/launcher.c -- the only caller,
 * compiled into the same binary. Six arguments, deliberately: a signature this small is
 * one a reader can check against the other file at a glance, which is what stands in
 * for the header this pair is too small to deserve. */

/* Post one notification, or -- with a NULL body -- only ask for permission, which is what
 * install.sh does at install time so the "claude-board would like to send you
 * notifications" prompt lands while the reader is still looking at their terminal rather
 * than at the first boundary of a work interval hours later.
 *
 * `title` names the kind of thing that happened -- "Pomodoro" beside "Board"
 * (ADR.md entry 58) -- and, like `body`, always crosses here as one of
 * bin/launcher.c's own MESSAGES literals: never a byte of argv reaches this function
 * unrouted through that table. Unused in the authorize-only call (`body == NULL`),
 * where there is nothing yet to title.
 *
 * `cue_name` is NULL for "cross this boundary silently" (a phase set to `None`, or an
 * argv that failed bin/launcher.c's is_safe_cue_name filter) and otherwise a bare name
 * out of /System/Library/Sounds, e.g. "Glass" -- passed to soundNamed: with NO extension
 * appended. QUIRKS.md ("soundNamed: searches /System/Library/Sounds and does NOT search
 * the app bundle") measured this: Apple's documented search path (bundle Resources, then
 * ~/Library/Sounds, never the system directory) is backwards on this machine in both
 * halves -- a bare name resolves straight against /System/Library/Sounds, a file staged
 * into this bundle's own Resources under the same name is never even looked at, and the
 * extension is optional (macOS appends it itself; the two spellings resolve to the same
 * file). There is therefore no install-time staging step for sound files -- ADR.md entry
 * 20's staging plan did not survive that measurement -- and nothing here should start to
 * assume one. An unresolvable name here is silence, not a fallback to the default sound
 * (also measured); this function does not branch on that either way.
 *
 * `use_default_sound`, nonzero, plays the system default sound regardless of `cue_name`
 * (bin/launcher.c always pairs it with a NULL `cue_name` -- there is no cue picker for a
 * row that sets this; a choosable sound for the board banner was never in scope). Kept
 * as its own argument rather than folded into `cue_name`: NULL
 * already means "no sound property at all", the silence a phase set to `None` needs, and
 * that has to stay reachable alongside "play the default" rather than the two sharing one
 * meaning for NULL.
 *
 * `board_url` non-NULL selects the click-serving mode described above: the notification
 * carries an action category, this process stays alive until the reviewer clicks, a
 * signal arrives, or `click_seconds` elapses, and it withdraws its own delivered
 * notification on the way out. Already filtered by bin/launcher.c's cb_is_board_url --
 * nothing here re-derives what a board URL is, so there is one such pattern in the
 * product and it is in C. NULL restores the fire-and-exit behaviour every other mode
 * has, and `click_seconds` is then unused.
 *
 * Returns 0 if the notification was handed to Notification Center (or, in the
 * authorize-only case, if permission was granted), 1 otherwise. A click that never came
 * is not a failure: the banner was raised, which was the errand. The caller treats a
 * failure as a failure to notify and nothing more: a reader's notification settings must
 * never be a way to take the pomodoro clock, or the daemon, down. */
int cb_notify(const char *title, const char *body, const char *cue_name, int use_default_sound,
              const char *board_url, int click_seconds) {
  @autoreleasepool {
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];

    /* The identifier is minted here rather than at the request, because the click-serving
     * mode has to be able to withdraw THIS notification and no other: withdrawing
     * everything delivered would take out the pomodoro boundary the reader has not read
     * yet, and this process has no business touching a banner it did not post. */
    NSString *identifier = [[NSUUID UUID] UUIDString];

    /* Strong, because UNUserNotificationCenter's own `delegate` property is weak: left
     * to the center alone this would be deallocated the moment the setup below returns,
     * and the click would arrive at nothing. nil for every mode that is not serving a
     * click, which is also what the run loop below tests to decide whether to linger. */
    CBRoundDelegate *delegate = nil;
    if (body != NULL && board_url != NULL) {
      delegate = [[CBRoundDelegate alloc] init];
      delegate.boardURL = [NSString stringWithUTF8String:board_url];

      /* Ordering: become an app, take the delegate and the category, and only then post.
       * A response cannot be routed to a delegate that was not set when the notification
       * was delivered, and macOS drops a categoryIdentifier that names no registered
       * category. */
      [NSApplication sharedApplication];
      [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
      [NSApp finishLaunching];

      center.delegate = delegate;
      UNNotificationAction *open =
          [UNNotificationAction actionWithIdentifier:kOpenBoardAction
                                               title:@"Open board"
                                             options:UNNotificationActionOptionForeground];
      UNNotificationCategory *category =
          [UNNotificationCategory categoryWithIdentifier:kRoundCategory
                                                 actions:@[ open ]
                                       intentIdentifiers:@[]
                                                 options:UNNotificationCategoryOptionNone];
      [center setNotificationCategories:[NSSet setWithObject:category]];

      install_stop_handlers();
    }
    /* Written and read only on this thread and on the completion handlers' queue, and
     * the run loop below is what synchronises the two: `done` is not set until a handler
     * has run to completion, and the loop reads it only between drains. */
    __block int done = 0;
    __block int failed = 1;

    /* Requested on every post, not once at install: authorization is the reader's to
     * revoke at any moment in System Settings, and asking again is how this finds out.
     * Already-granted resolves immediately without a prompt -- macOS shows the prompt
     * exactly once per bundle -- so the common path costs one IPC round trip. */
    [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                          completionHandler:^(BOOL granted, NSError *error) {
      if (!granted) {
        fprintf(stderr, "claude-board: notifications not authorized%s%s\n",
                error ? ": " : "",
                error ? [[error localizedDescription] UTF8String] : "");
        done = 1;
        return;
      }
      if (body == NULL) { /* authorize-only: permission was the whole errand. */
        failed = 0;
        done = 1;
        return;
      }

      UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
      content.title = [NSString stringWithUTF8String:title];
      content.body = [NSString stringWithUTF8String:body];
      /* soundNamed:, not defaultSound:, for the cue-picking rows -- a bare name resolves
       * straight against /System/Library/Sounds (QUIRKS.md, measured -- see cb_notify's
       * own comment above), the same directory the osascript path's `sound name` clause
       * resolves against (src/notify.mjs) -- "the same sound on each" install, with no
       * bundle staging step for either path to depend on. use_default_sound is the one
       * row-shaped exception: it wants the system default whatever cue_name says (always
       * NULL for that row), and defaultSound is genuinely a different call, not a name
       * soundNamed: would ever resolve. No sound property at all when neither applies --
       * that is what makes a phase set to `None` cross silently, with no separate branch
       * for it to fall out of sync with. */
      if (use_default_sound) {
        content.sound = [UNNotificationSound defaultSound];
      } else if (cue_name != NULL) {
        content.sound = [UNNotificationSound soundNamed:[NSString stringWithUTF8String:cue_name]];
      }

      /* The category is what gives the banner its action and what routes a click back to
       * the delegate above; set only when there is a delegate to receive it. */
      if (delegate != nil) content.categoryIdentifier = kRoundCategory;

      /* trigger:nil means deliver now. The identifier is fresh per post rather than
       * constant, because a repeated identifier REPLACES the notification already in
       * Notification Center -- which for a reader who left "Alerts" on and stepped away
       * would silently eat the boundary they missed. */
      UNNotificationRequest *request =
          [UNNotificationRequest requestWithIdentifier:identifier
                                               content:content
                                               trigger:nil];
      [center addNotificationRequest:request withCompletionHandler:^(NSError *postError) {
        if (postError) {
          fprintf(stderr, "claude-board: could not post notification: %s\n",
                  [[postError localizedDescription] UTF8String]);
        } else {
          failed = 0;
        }
        done = 1;
      }];
    }];

    /* Both calls above are asynchronous and this process has no other reason to exist, so
     * something has to keep the run loop alive for their handlers to land on.
     *
     * Two deadlines, because the two modes wait on different things. Posting waits on
     * Notification Center, which answers in milliseconds; ten seconds there is a leak
     * stop, not a timeout anyone should reach, and it has to be short because this is
     * spawned once per pomodoro boundary by a daemon that never waits for it -- a service
     * that stops answering must leave behind a missing banner, not a process per boundary
     * accumulating for as long as the reader's day lasts. Authorizing waits on a HUMAN:
     * the first request per bundle puts a dialog on screen and the handler does not fire
     * until it is answered. Ten seconds would have timed out on someone reaching for
     * their mouse, and install.sh (the only caller of this mode) is a script the reader
     * is already sitting in front of watching prompts go by. Two minutes matches the
     * window it already allows for the Documents-folder dialog. */
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:(body == NULL ? 120.0 : 10.0)];
    /* `stop_requested` is tested here as well as in the serve loop below, and it has to
     * be: installing a handler REPLACES the default disposition, so between the handler
     * going in and the serve loop starting, a SIGTERM that would have killed this process
     * outright now merely sets a flag. Without this test the child would swallow the
     * daemon's kill, post the banner anyway, and only then notice -- and the daemon
     * forgets the child at the moment it signals it, so nothing would ever signal it
     * again. That is a delivered, clickable banner for a round that has already been
     * answered, which is the state criteria 6 and 15 exist to prevent. Falling out here
     * lands on the withdrawal below, so a banner delivered a moment before the signal is
     * taken back down. Nothing changes for the fire-and-exit modes: they install no
     * handler, so this flag is never set for them and SIGTERM still kills them outright. */
    while (!done && !stop_requested && [deadline timeIntervalSinceNow] > 0) {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                               beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    if (!done && !stop_requested) fprintf(stderr, "claude-board: notification timed out\n");

    /* The click-serving mode leaves by exactly one door from here on, because every way
     * out of it has to withdraw. `failed` is not a proxy for "nothing was delivered": it
     * starts at 1 and is only cleared inside addNotificationRequest's completion handler,
     * so a Notification Center slow enough to miss the deadline above -- a loaded
     * machine, the minute after a wake -- leaves a banner on screen and this process
     * believing it failed. Returning there was a banner with no process behind it, and a
     * click on one of those has LaunchServices launch this binary with no argv, which is
     * the daemon supervisor (see this file's header). */
    if (delegate == nil) return failed;
    if (failed) {
      withdraw_own_notification(center, identifier);
      /* A stop this process was ASKED for is not a failure to notify. The daemon kills
       * this child the moment the reviewer comes back to the board or the round is
       * answered, and inside the post window that kill now arrives as `stop_requested`
       * rather than as the default disposition killing the process outright -- so
       * reporting it as a failure would have src/notify.mjs log "notifications may not be
       * appearing" on a perfectly healthy path AND burn its one-shot warning, leaving a
       * genuinely broken notifier later in that daemon's run unreported. A post that
       * simply never came back still returns failure: nobody asked for that. */
      return stop_requested ? 0 : failed;
    }

    /* --- Serving the click ------------------------------------------------------
     *
     * Three ways this ends, and the daemon owns two of them. It kills this process
     * when the reviewer comes back to the board or the round is answered, which
     * arrives here as `stop_requested`; and it dies with the job when
     * launchd stops the daemon, which arrives the same way. The third is this process's
     * own: `click_seconds` is the round's remaining wait, after which there is nothing
     * left to open, and a lapsing wait fires no event a child could have been told to
     * wait for -- so the backstop is a deadline rather than a message.
     *
     * ponytail: a one-second poll rather than a dispatch source per signal. The ceiling
     * is a second of latency on the daemon's kill and one wakeup a second for the length
     * of a round's wait; the upgrade path is a dispatch_source_t per signal on the main
     * queue, which this run loop already services. */
    NSDate *serveUntil = [NSDate dateWithTimeIntervalSinceNow:(double)click_seconds];
    while (!stop_requested && !delegate.clicked && [serveUntil timeIntervalSinceNow] > 0) {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                               beforeDate:[NSDate dateWithTimeIntervalSinceNow:1.0]];
    }

    /* A click a second before the deadline must still open the board: the open is
     * asynchronous, so once the reviewer has acted this waits on LaunchServices rather
     * than on the round. Bounded on its own account -- an open that never answers must
     * not become the immortal process the deadline above exists to prevent. */
    if (delegate.clicked) {
      NSDate *openUntil = [NSDate dateWithTimeIntervalSinceNow:10.0];
      while (!delegate.served && [openUntil timeIntervalSinceNow] > 0) {
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                                 beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
      }
    }

    /* Withdrawn on every exit path this branch has -- the click, the daemon's signal, the
     * deadline, and the failed-to-confirm path above (criterion 6). */
    withdraw_own_notification(center, identifier);
    return 0;
  }
}
