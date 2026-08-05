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
#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

/* Matched by hand against the extern declaration in bin/launcher.c -- the only caller,
 * compiled into the same binary. Two scalar arguments, deliberately: a signature this
 * small is one a reader can check against the other file at a glance, which is what
 * stands in for the header this pair is too small to deserve. */

/* The title is a literal here rather than an argument for the same reason bin/launcher.c
 * keeps the message bodies in a closed table: this binary holds a TCC grant to the
 * reader's Documents folder, and the less of what it displays comes from argv, the less
 * there is to think about when someone can write the launchd plist. */
static NSString *const kTitle = @"Pomodoro";

/* Post one notification, or -- with a NULL body -- only ask for permission, which is what
 * install.sh does at install time so the "claude-board would like to send you
 * notifications" prompt lands while the reader is still looking at their terminal rather
 * than at the first boundary of a work interval hours later.
 *
 * Returns 0 if the notification was handed to Notification Center (or, in the
 * authorize-only case, if permission was granted), 1 otherwise. The caller treats a
 * failure as a failure to notify and nothing more: a reader's notification settings must
 * never be a way to take the pomodoro clock, or the daemon, down. */
int cb_notify(const char *body, int with_sound) {
  @autoreleasepool {
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
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
      content.title = kTitle;
      content.body = [NSString stringWithUTF8String:body];
      /* defaultSound, not the "Glass" the osascript path named: UNNotificationSound
       * resolves a name against the app bundle's own Resources, and criterion 14 of
       * SPEC_POMODORO.md ("no audio file added to the repo") is why there is nothing
       * there to resolve. The reader asked for a sound, not for that sound. */
      if (with_sound) content.sound = [UNNotificationSound defaultSound];

      /* trigger:nil means deliver now. The identifier is fresh per post rather than
       * constant, because a repeated identifier REPLACES the notification already in
       * Notification Center -- which for a reader who left "Alerts" on and stepped away
       * would silently eat the boundary they missed. */
      UNNotificationRequest *request =
          [UNNotificationRequest requestWithIdentifier:[[NSUUID UUID] UUIDString]
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
    while (!done && [deadline timeIntervalSinceNow] > 0) {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode
                               beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
    }
    if (!done) fprintf(stderr, "claude-board: notification timed out\n");
    return failed;
  }
}
