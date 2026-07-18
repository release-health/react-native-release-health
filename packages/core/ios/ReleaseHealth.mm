#import "ReleaseHealth.h"
#import <UIKit/UIKit.h>

static NSString *const kCleanExitKey = @"ReleaseHealth.cleanExit";
static NSString *const kPendingUpdateIdKey = @"ReleaseHealth.pendingUpdateId";
static NSString *const kPendingUpdateDownloadedAtKey = @"ReleaseHealth.pendingUpdateDownloadedAt";
static NSString *const kLaunchCountKey = @"ReleaseHealth.launchCountSinceUpdate";

@implementation ReleaseHealth {
    BOOL _previousCleanExit;
}

- (instancetype)init
{
    if (self = [super init]) {
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];

        // Captured once, before this launch resets the persisted flag below.
        // Defaults to YES so a first-ever launch is never flagged abnormal.
        if ([defaults objectForKey:kCleanExitKey] == nil) {
            _previousCleanExit = YES;
        } else {
            _previousCleanExit = [defaults boolForKey:kCleanExitKey];
        }
        [defaults setBool:NO forKey:kCleanExitKey];

        [[NSNotificationCenter defaultCenter] addObserver:self
                                                  selector:@selector(handleGracefulBackgrounding)
                                                      name:UIApplicationDidEnterBackgroundNotification
                                                    object:nil];
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                  selector:@selector(handleGracefulBackgrounding)
                                                      name:UIApplicationWillTerminateNotification
                                                    object:nil];
    }
    return self;
}

- (void)dealloc
{
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (void)handleGracefulBackgrounding
{
    [[NSUserDefaults standardUserDefaults] setBool:YES forKey:kCleanExitKey];
}

- (NSDictionary *)getBuildInfo
{
    NSDictionary *info = [NSBundle mainBundle].infoDictionary;
    NSString *version = info[@"CFBundleShortVersionString"] ?: @"";
    NSString *buildNumber = info[@"CFBundleVersion"] ?: @"";
    NSString *bundleIdentifier = [NSBundle mainBundle].bundleIdentifier ?: @"";

    return @{
        @"version": version,
        @"buildNumber": buildNumber,
        @"bundleIdentifier": bundleIdentifier,
    };
}

- (NSNumber *)getPreviousCleanExit
{
    return @(_previousCleanExit);
}

- (NSDictionary * _Nullable)getPendingUpdate
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *updateId = [defaults stringForKey:kPendingUpdateIdKey];
    if (updateId == nil) {
        return nil;
    }

    double downloadedAt = [defaults doubleForKey:kPendingUpdateDownloadedAtKey];
    return @{
        @"updateId": updateId,
        @"downloadedAt": @(downloadedAt),
    };
}

- (void)setPendingUpdate:(NSString *)updateId downloadedAt:(double)downloadedAt
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults setObject:updateId forKey:kPendingUpdateIdKey];
    [defaults setDouble:downloadedAt forKey:kPendingUpdateDownloadedAtKey];
}

- (void)clearPendingUpdate
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults removeObjectForKey:kPendingUpdateIdKey];
    [defaults removeObjectForKey:kPendingUpdateDownloadedAtKey];
}

- (NSNumber *)getLaunchCountSinceUpdate
{
    NSInteger count = [[NSUserDefaults standardUserDefaults] integerForKey:kLaunchCountKey];
    return @(count);
}

- (NSNumber *)incrementLaunchCountSinceUpdate
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSInteger next = [defaults integerForKey:kLaunchCountKey] + 1;
    [defaults setInteger:next forKey:kLaunchCountKey];
    return @(next);
}

- (void)resetLaunchCountSinceUpdate
{
    [[NSUserDefaults standardUserDefaults] setInteger:0 forKey:kLaunchCountKey];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeReleaseHealthSpecJSI>(params);
}

+ (NSString *)moduleName
{
  return @"ReleaseHealth";
}

@end
