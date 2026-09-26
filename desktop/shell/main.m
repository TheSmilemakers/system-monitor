// System Monitor: the native shell.
//
// A window of its own around the bench instead of a browser tab. It starts
// the server (production build, built on first run), shows the bench in a
// WebKit view, posts macOS notifications for alarms as itself rather than
// through osascript, keeps an alarm count on the dock badge, and stops the
// server it started when it quits. Objective-C so that clang from the
// Command Line Tools builds it; see scripts/build-shell.sh.

#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>
#import <WebKit/WebKit.h>

static NSInteger gPort = 3000;
static NSString *gBase;
static NSString *gSupportDir;
static NSString *gLogPath;

static void SMLog(NSString *message) {
  NSString *line = [NSString stringWithFormat:@"%@ %@\n", [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]], message];
  NSFileHandle *h = [NSFileHandle fileHandleForWritingAtPath:gLogPath];
  if (!h) {
    [line writeToFile:gLogPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
    return;
  }
  [h seekToEndOfFile];
  [h writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
  [h closeFile];
}

/// The project to run: SM_PROJECT_DIR, then the `project` file beside the
/// monitor's state (a path on one line), then the usual checkout.
static NSString *SMProjectDir(void) {
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *env = [[NSProcessInfo processInfo] environment][@"SM_PROJECT_DIR"];
  if (env.length && [fm fileExistsAtPath:env]) return env;
  NSString *pointer = [gSupportDir stringByAppendingPathComponent:@"project"];
  NSString *text = [NSString stringWithContentsOfFile:pointer encoding:NSUTF8StringEncoding error:nil];
  NSString *dir = [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (dir.length && [fm fileExistsAtPath:[dir stringByAppendingPathComponent:@"package.json"]]) return dir;
  return [NSHomeDirectory() stringByAppendingPathComponent:@"projects/system-monitor"];
}

/// One GET, synchronously, from a background queue. Nil when the server is not there.
static NSData *SMFetch(NSString *path, NSTimeInterval timeout, NSInteger *status) {
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:[gBase stringByAppendingString:path]]
                                                     cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                                 timeoutInterval:timeout];
  [req setValue:[NSString stringWithFormat:@"127.0.0.1:%ld", (long)gPort] forHTTPHeaderField:@"Host"];
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSData *result = nil;
  __block NSInteger code = 0;
  [[[NSURLSession sharedSession] dataTaskWithRequest:req
                                   completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                                     if ([response isKindOfClass:[NSHTTPURLResponse class]] && data) {
                                       code = [(NSHTTPURLResponse *)response statusCode];
                                       result = data;
                                     }
                                     dispatch_semaphore_signal(done);
                                   }] resume];
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
  if (status) *status = code;
  return result;
}

static void SMPost(NSString *path, NSDictionary *json) {
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:[gBase stringByAppendingString:path]]];
  req.HTTPMethod = @"POST";
  req.timeoutInterval = 5;
  [req setValue:[NSString stringWithFormat:@"127.0.0.1:%ld", (long)gPort] forHTTPHeaderField:@"Host"];
  [req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  req.HTTPBody = [NSJSONSerialization dataWithJSONObject:json options:0 error:nil];
  [[[NSURLSession sharedSession] dataTaskWithRequest:req] resume];
}

static BOOL SMNotificationsOn(void) {
  NSInteger status = 0;
  NSData *data = SMFetch(@"/api/settings", 5, &status);
  if (!data || status != 200) return YES;
  NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  id v = [json isKindOfClass:[NSDictionary class]] ? json[@"notifications"] : nil;
  return [v isKindOfClass:[NSNumber class]] ? [v boolValue] : YES;
}

#pragma mark - Server

/// Runs the server for the shell's lifetime, unless one is already there.
@interface SMServer : NSObject
@property(nonatomic, strong) NSTask *task;
@property(nonatomic) BOOL owned;
@property(nonatomic, copy) NSString *dir;
@end

@implementation SMServer

- (instancetype)init {
  if ((self = [super init])) _dir = SMProjectDir();
  return self;
}

- (NSDictionary *)environment {
  NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
  NSString *home = NSHomeDirectory();
  env[@"PATH"] = [NSString stringWithFormat:@"%@/.bun/bin:%@/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", home, home];
  env[@"SM_NOTIFIER"] = @"app";  // the shell posts notifications; the server stays quiet
  env[@"NODE_ENV"] = @"production";
  return env;
}

- (NSTask *)taskWithArguments:(NSArray<NSString *> *)args {
  NSTask *t = [NSTask new];
  t.executableURL = [NSURL fileURLWithPath:@"/usr/bin/arch"];
  t.arguments = [@[ @"-arm64" ] arrayByAddingObjectsFromArray:args];
  t.currentDirectoryURL = [NSURL fileURLWithPath:self.dir];
  t.environment = [self environment];
  NSFileHandle *out = [NSFileHandle fileHandleForWritingAtPath:gLogPath];
  [out seekToEndOfFile];
  t.standardOutput = out;
  t.standardError = out;
  return t;
}

- (BOOL)reachable:(NSTimeInterval)timeout {
  NSInteger status = 0;
  return SMFetch(@"/api/stats", timeout, &status) != nil && status < 500;
}

/// No production build, or one older than the newest source file: build again.
- (BOOL)buildIsStale {
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *buildId = [self.dir stringByAppendingPathComponent:@".next/BUILD_ID"];
  NSDate *built = [fm attributesOfItemAtPath:buildId error:nil][NSFileModificationDate];
  if (!built) return YES;
  NSArray *roots = @[ @"src", @"package.json", @"next.config.ts", @"tsconfig.json", @"bun.lock" ];
  for (NSString *root in roots) {
    NSString *path = [self.dir stringByAppendingPathComponent:root];
    BOOL isDir = NO;
    if (![fm fileExistsAtPath:path isDirectory:&isDir]) continue;
    if (!isDir) {
      NSDate *m = [fm attributesOfItemAtPath:path error:nil][NSFileModificationDate];
      if (m && [m compare:built] == NSOrderedDescending) return YES;
      continue;
    }
    NSDirectoryEnumerator *walk = [fm enumeratorAtPath:path];
    for (NSString *rel in walk) {
      NSDate *m = walk.fileAttributes[NSFileModificationDate];
      if (m && [m compare:built] == NSOrderedDescending) {
        SMLog([NSString stringWithFormat:@"build is older than %@/%@", root, rel]);
        return YES;
      }
    }
  }
  return NO;
}

/// Start, building first when there is no production build or it is stale. Returns an error to show, or nil.
- (NSString *)startWithStatus:(void (^)(NSString *))status {
  if ([self reachable:2]) {
    SMLog([NSString stringWithFormat:@"a server already answers on %ld; attaching", (long)gPort]);
    return nil;
  }
  NSFileManager *fm = [NSFileManager defaultManager];
  if (![fm fileExistsAtPath:[self.dir stringByAppendingPathComponent:@"package.json"]]) {
    return [NSString stringWithFormat:@"No project at %@. Set SM_PROJECT_DIR or write the path to %@/project.", self.dir, gSupportDir];
  }
  NSString *bun = [NSHomeDirectory() stringByAppendingPathComponent:@".bun/bin/bun"];
  if ([self buildIsStale]) {
    status(@"Building the app. This takes about a minute.");
    SMLog([NSString stringWithFormat:@"building in %@", self.dir]);
    NSTask *build = [self taskWithArguments:@[ bun, @"run", @"build" ]];
    NSError *err = nil;
    if (![build launchAndReturnError:&err]) return [NSString stringWithFormat:@"Could not start the build: %@", err.localizedDescription];
    [build waitUntilExit];
    if (build.terminationStatus != 0) return [NSString stringWithFormat:@"The build failed. See %@.", gLogPath];
  }
  status(@"Starting the server.");
  NSTask *t = [self taskWithArguments:@[ bun, @"run", @"start", @"--port", [@(gPort) stringValue] ]];
  NSError *err = nil;
  if (![t launchAndReturnError:&err]) return [NSString stringWithFormat:@"Could not start the server: %@", err.localizedDescription];
  self.task = t;
  self.owned = YES;
  SMLog([NSString stringWithFormat:@"started server pid %d in %@", t.processIdentifier, self.dir]);
  for (int i = 0; i < 120; i++) {
    if ([self reachable:3]) return nil;
    if (!t.isRunning) return [NSString stringWithFormat:@"The server exited early. See %@.", gLogPath];
    [NSThread sleepForTimeInterval:0.5];
  }
  return [NSString stringWithFormat:@"The server did not answer within a minute. See %@.", gLogPath];
}

- (NSString *)rebuildWithStatus:(void (^)(NSString *))status {
  [self stop];
  [[NSFileManager defaultManager] removeItemAtPath:[self.dir stringByAppendingPathComponent:@".next/BUILD_ID"] error:nil];
  return [self startWithStatus:status];
}

- (void)stop {
  if (!self.owned || !self.task.isRunning) return;
  SMLog([NSString stringWithFormat:@"stopping server pid %d", self.task.processIdentifier]);
  [self.task terminate];
  [self.task waitUntilExit];
  self.task = nil;
  self.owned = NO;
}

@end

#pragma mark - Alarms

/// Watches the timeline for alarms and posts them as the app.
@interface SMAlarms : NSObject
@property(nonatomic) double lastSeen;
@property(nonatomic, strong) NSMutableSet<NSString *> *seen;
@property(nonatomic) NSInteger unread;
@property(nonatomic, strong) NSTimer *timer;
@end

@implementation SMAlarms

- (instancetype)init {
  if ((self = [super init])) {
    _lastSeen = [[NSDate date] timeIntervalSince1970] * 1000;
    _seen = [NSMutableSet set];
  }
  return self;
}

- (void)start {
  [[UNUserNotificationCenter currentNotificationCenter]
      requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
                    completionHandler:^(BOOL granted, NSError *error) {
                      SMLog([NSString stringWithFormat:@"notification permission: %d %@", granted, error ?: @""]);
                    }];
  self.timer = [NSTimer scheduledTimerWithTimeInterval:30 repeats:YES block:^(NSTimer *t) { [self poll]; }];
  [self poll];
}

- (void)clearUnread {
  self.unread = 0;
  [NSApp dockTile].badgeLabel = nil;
}

- (void)poll {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSInteger status = 0;
    NSData *data = SMFetch([NSString stringWithFormat:@"/api/timeline?since=%lld", (long long)self.lastSeen], 10, &status);
    if (!data || status != 200) return;
    NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    NSArray *events = [json isKindOfClass:[NSDictionary class]] ? json[@"events"] : nil;
    if (![events isKindOfClass:[NSArray class]]) return;
    NSMutableArray<NSDictionary *> *urgent = [NSMutableArray array];
    for (NSDictionary *e in events) {
      if (![e isKindOfClass:[NSDictionary class]]) continue;
      NSString *eid = e[@"id"];
      if (![eid isKindOfClass:[NSString class]] || [self.seen containsObject:eid]) continue;
      [self.seen addObject:eid];
      if ([e[@"ts"] isKindOfClass:[NSNumber class]]) self.lastSeen = MAX(self.lastSeen, [e[@"ts"] doubleValue]);
      if ([e[@"severity"] isEqual:@"alarm"] || [e[@"category"] isEqual:@"watch"]) [urgent addObject:e];
    }
    if (urgent.count == 0) return;
    BOOL on = SMNotificationsOn();
    dispatch_async(dispatch_get_main_queue(), ^{
      if (![NSApp isActive]) {
        self.unread += (NSInteger)urgent.count;
        [NSApp dockTile].badgeLabel = [@(self.unread) stringValue];
      }
      if (!on) return;
      UNMutableNotificationContent *content = [UNMutableNotificationContent new];
      content.title = @"System Monitor";
      NSString *first = [urgent[0][@"message"] isKindOfClass:[NSString class]] ? urgent[0][@"message"] : @"Alarm";
      content.body = urgent.count == 1
                         ? first
                         : [NSString stringWithFormat:@"%lu alarms. %@ Open the Timeline for the rest.", (unsigned long)urgent.count, first];
      content.sound = [UNNotificationSound defaultSound];
      UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:[[NSUUID UUID] UUIDString] content:content trigger:nil];
      [[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:request
                                                             withCompletionHandler:^(NSError *error) {
                                                               if (error) SMLog([NSString stringWithFormat:@"notification failed: %@", error]);
                                                             }];
    });
  });
}

@end

#pragma mark - App

@interface SMAppDelegate : NSObject <NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, UNUserNotificationCenterDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *web;
@property(nonatomic, strong) SMServer *server;
@property(nonatomic, strong) SMAlarms *alarms;
@property(nonatomic, strong) NSMenuItem *muteItem;
@end

@implementation SMAppDelegate

- (void)showStatus:(NSString *)message {
  NSString *safe = [[message stringByReplacingOccurrencesOfString:@"&" withString:@"&amp;"] stringByReplacingOccurrencesOfString:@"<" withString:@"&lt;"];
  NSString *html = [NSString stringWithFormat:
      @"<html><body style=\"margin:0;background:#050608;color:#e8e6df;font:15px -apple-system,Helvetica;display:flex;align-items:center;justify-content:center;height:100vh\">"
       "<div style=\"text-align:center;max-width:36em\"><div style=\"font-size:22px;color:#5dff9e;letter-spacing:.06em;margin-bottom:12px\">SYSTEM MONITOR</div>%@</div></body></html>", safe];
  [self.web loadHTMLString:html baseURL:nil];
}

- (void)loadBench {
  [self.web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:[gBase stringByAppendingString:@"/"]]]];
}

- (void)buildMenu {
  NSMenu *main = [NSMenu new];

  NSMenuItem *appItem = [NSMenuItem new];
  [main addItem:appItem];
  NSMenu *app = [NSMenu new];
  [app addItemWithTitle:@"About System Monitor" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
  [app addItem:[NSMenuItem separatorItem]];
  [app addItemWithTitle:@"Hide System Monitor" action:@selector(hide:) keyEquivalent:@"h"];
  [app addItem:[NSMenuItem separatorItem]];
  [app addItemWithTitle:@"Quit System Monitor" action:@selector(terminate:) keyEquivalent:@"q"];
  appItem.submenu = app;

  NSMenuItem *editItem = [NSMenuItem new];
  [main addItem:editItem];
  NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Edit"];
  [edit addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
  [edit addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
  [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
  editItem.submenu = edit;

  NSMenuItem *viewItem = [NSMenuItem new];
  [main addItem:viewItem];
  NSMenu *view = [[NSMenu alloc] initWithTitle:@"View"];
  [view addItemWithTitle:@"Reload" action:@selector(reload:) keyEquivalent:@"r"];
  [view addItemWithTitle:@"Open in Browser" action:@selector(openInBrowser:) keyEquivalent:@"b"];
  [view addItemWithTitle:@"Shift Report" action:@selector(openReport:) keyEquivalent:@"p"];
  [view addItem:[NSMenuItem separatorItem]];
  [view addItemWithTitle:@"Enter Full Screen" action:@selector(toggleFullScreen:) keyEquivalent:@"f"];
  viewItem.submenu = view;

  NSMenuItem *monitorItem = [NSMenuItem new];
  [main addItem:monitorItem];
  NSMenu *monitor = [[NSMenu alloc] initWithTitle:@"Monitor"];
  self.muteItem = [[NSMenuItem alloc] initWithTitle:@"Mute Notifications" action:@selector(toggleMute:) keyEquivalent:@"m"];
  [monitor addItem:self.muteItem];
  [monitor addItemWithTitle:@"Rebuild and Restart Server" action:@selector(rebuild:) keyEquivalent:@""];
  [monitor addItemWithTitle:@"Show Log" action:@selector(showLog:) keyEquivalent:@""];
  monitorItem.submenu = monitor;

  [NSApp setMainMenu:main];
}

- (void)refreshMuteItem {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    BOOL on = SMNotificationsOn();
    dispatch_async(dispatch_get_main_queue(), ^{ self.muteItem.state = on ? NSControlStateValueOff : NSControlStateValueOn; });
  });
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  self.server = [SMServer new];
  self.alarms = [SMAlarms new];
  SMLog([NSString stringWithFormat:@"shell starting; project %@", self.server.dir]);
  [UNUserNotificationCenter currentNotificationCenter].delegate = self;
  [self buildMenu];

  WKWebViewConfiguration *config = [WKWebViewConfiguration new];
  [config.preferences setValue:@YES forKey:@"developerExtrasEnabled"];
  self.web = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:config];
  self.web.UIDelegate = self;
  self.web.navigationDelegate = self;
  [self.web setValue:@NO forKey:@"drawsBackground"];

  self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1440, 960)
                                            styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                                              backing:NSBackingStoreBuffered
                                                defer:NO];
  self.window.title = @"System Monitor";
  self.window.minSize = NSMakeSize(720, 480);
  [self.window setFrameAutosaveName:@"SystemMonitorMain"];
  self.window.contentView = self.web;
  self.window.backgroundColor = [NSColor colorWithRed:0.02 green:0.024 blue:0.031 alpha:1];
  [self.window center];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [self showStatus:@"Starting System Monitor."];

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSString *error = [self.server startWithStatus:^(NSString *m) {
      dispatch_async(dispatch_get_main_queue(), ^{ [self showStatus:m]; });
    }];
    dispatch_async(dispatch_get_main_queue(), ^{
      if (error) {
        [self showStatus:error];
        return;
      }
      [self loadBench];
      [self.alarms start];
      [self refreshMuteItem];
    });
  });
}

- (void)reload:(id)sender { [self.web reload]; }
- (void)openInBrowser:(id)sender { [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:[gBase stringByAppendingString:@"/"]]]; }
- (void)openReport:(id)sender { [[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:[gBase stringByAppendingString:@"/report"]]]; }
- (void)showLog:(id)sender { [[NSWorkspace sharedWorkspace] openURL:[NSURL fileURLWithPath:gLogPath]]; }
- (void)toggleMute:(id)sender {
  BOOL mute = self.muteItem.state == NSControlStateValueOff;
  SMPost(@"/api/settings", @{ @"notifications" : @(!mute) });
  self.muteItem.state = mute ? NSControlStateValueOn : NSControlStateValueOff;
}
- (void)rebuild:(id)sender {
  [self showStatus:@"Rebuilding."];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSString *error = [self.server rebuildWithStatus:^(NSString *m) {
      dispatch_async(dispatch_get_main_queue(), ^{ [self showStatus:m]; });
    }];
    dispatch_async(dispatch_get_main_queue(), ^{
      if (error) [self showStatus:error];
      else [self loadBench];
    });
  });
}

- (void)applicationDidBecomeActive:(NSNotification *)notification { [self.alarms clearUnread]; }
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }
- (void)applicationWillTerminate:(NSNotification *)notification { [self.server stop]; }

// Links that ask for a new window (the report, the mini window) open in the browser.
- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)navigationAction
                    windowFeatures:(WKWindowFeatures *)windowFeatures {
  if (navigationAction.request.URL) [[NSWorkspace sharedWorkspace] openURL:navigationAction.request.URL];
  return nil;
}

// The bench confirms destructive actions with window.confirm; give it a real sheet.
- (void)webView:(WKWebView *)webView
    runJavaScriptConfirmPanelWithMessage:(NSString *)message
                        initiatedByFrame:(WKFrameInfo *)frame
                       completionHandler:(void (^)(BOOL))completionHandler {
  NSAlert *alert = [NSAlert new];
  alert.messageText = message;
  [alert addButtonWithTitle:@"OK"];
  [alert addButtonWithTitle:@"Cancel"];
  [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse r) { completionHandler(r == NSAlertFirstButtonReturn); }];
}

- (void)webView:(WKWebView *)webView
    runJavaScriptAlertPanelWithMessage:(NSString *)message
                      initiatedByFrame:(WKFrameInfo *)frame
                     completionHandler:(void (^)(void))completionHandler {
  NSAlert *alert = [NSAlert new];
  alert.messageText = message;
  [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse r) { completionHandler(); }];
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  SMLog([NSString stringWithFormat:@"navigation failed: %@", error]);
  [self showStatus:@"The server is not answering. Rebuild and Restart Server is in the Monitor menu."];
}

// Show notifications even while the app is frontmost.
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
  completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
}

@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *portEnv = [[NSProcessInfo processInfo] environment][@"SM_PORT"];
    if (portEnv.integerValue > 0) gPort = portEnv.integerValue;
    gBase = [NSString stringWithFormat:@"http://127.0.0.1:%ld", (long)gPort];
    gSupportDir = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/system-monitor"];
    gLogPath = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Logs/SystemMonitor.log"];
    [[NSFileManager defaultManager] createDirectoryAtPath:gSupportDir withIntermediateDirectories:YES attributes:nil error:nil];
    if (![[NSFileManager defaultManager] fileExistsAtPath:gLogPath]) [@"" writeToFile:gLogPath atomically:YES encoding:NSUTF8StringEncoding error:nil];

    NSApplication *app = [NSApplication sharedApplication];
    SMAppDelegate *delegate = [SMAppDelegate new];
    app.delegate = delegate;
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    [app run];
  }
  return 0;
}
