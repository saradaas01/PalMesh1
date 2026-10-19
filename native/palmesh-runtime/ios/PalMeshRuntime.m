#import <React/RCTEventEmitter.h>
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>

@interface PalMeshRuntime : RCTEventEmitter
@property(nonatomic) BOOL observing;
@property(nonatomic) BOOL previousBatteryMonitoring;
@property(nonatomic) BOOL batteryMonitoring;
@end
@implementation PalMeshRuntime
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[@"PalMeshRuntimeEvent"]; }
- (void)enableBatteryMonitoring {
  if (_batteryMonitoring) return;
  _previousBatteryMonitoring = UIDevice.currentDevice.batteryMonitoringEnabled;
  UIDevice.currentDevice.batteryMonitoringEnabled = YES; _batteryMonitoring = YES;
}
- (NSDictionary *)battery {
  [self enableBatteryMonitoring]; float level = UIDevice.currentDevice.batteryLevel;
  UIDeviceBatteryState state = UIDevice.currentDevice.batteryState;
  return @{@"level":level < 0 ? (id)NSNull.null : @(MIN(1,MAX(0,level))),
    @"charging":@(state == UIDeviceBatteryStateCharging || state == UIDeviceBatteryStateFull),
    @"lowPower":@(NSProcessInfo.processInfo.lowPowerModeEnabled)};
}
- (void)batteryChanged:(NSNotification *)notification {
  if (_observing) [self sendEventWithName:@"PalMeshRuntimeEvent" body:@{@"type":@"battery",@"battery":[self battery]}];
}
- (void)startObserving {
  _observing = YES; [self enableBatteryMonitoring];
  for (NSString *name in @[UIDeviceBatteryLevelDidChangeNotification,UIDeviceBatteryStateDidChangeNotification,NSProcessInfoPowerStateDidChangeNotification])
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(batteryChanged:) name:name object:nil];
}
- (void)stopObserving { _observing = NO; [NSNotificationCenter.defaultCenter removeObserver:self]; }
RCT_REMAP_METHOD(getBatteryState, batteryWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve([self battery]); }
- (BOOL)notificationsAllowed:(UNNotificationSettings *)settings {
  return settings.authorizationStatus == UNAuthorizationStatusAuthorized || settings.authorizationStatus == UNAuthorizationStatusProvisional || settings.authorizationStatus == UNAuthorizationStatusEphemeral;
}
RCT_REMAP_METHOD(checkNotifications, checkNotificationsWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) { resolve(@([self notificationsAllowed:settings])); }];
}
/** Only called by an explicit UI action; constructing the module or checking
 * alert availability does not request notification permission. */
RCT_REMAP_METHOD(requestNotifications, requestNotificationsWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) { reject(@"FOREGROUND_REQUIRED",@"Request alerts from the open app",nil); return; }
  [UNUserNotificationCenter.currentNotificationCenter requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound completionHandler:^(BOOL granted, NSError *error) {
    if (error) reject(@"ALERT_UNAVAILABLE",@"Notification authorization is unavailable",error); else resolve(@(granted));
  }];
}
RCT_REMAP_METHOD(startMeshService, startMeshServiceWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  reject(@"BACKGROUND_UNAVAILABLE",@"iOS does not provide an Android-style foreground service; keep PalMesh open for reliable forwarding",nil);
}
RCT_REMAP_METHOD(stopMeshService, stopMeshServiceWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve(nil); }
- (BOOL)validId:(NSString *)identifier {
  if (![identifier isKindOfClass:NSString.class]) return NO;
  NSRange match = [identifier rangeOfString:@"^[A-Za-z0-9_-]{1,128}$" options:NSRegularExpressionSearch];
  return match.location == 0 && match.length == identifier.length;
}
RCT_REMAP_METHOD(showEmergencyNotification, showEmergency:(NSString *)identifier resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (![self validId:identifier]) { reject(@"INVALID_ALERT",@"Invalid alert identifier",nil); return; }
  [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
    if (![self notificationsAllowed:settings]) { reject(@"NOTIFICATIONS_DISABLED",@"Emergency notification permission is unavailable",nil); return; }
    BOOL arabic = [NSLocale.preferredLanguages.firstObject hasPrefix:@"ar"];
    UNMutableNotificationContent *content = [UNMutableNotificationContent new];
    content.title = arabic ? @"نداء استغاثة قريب" : @"Nearby emergency SOS";
    content.body = arabic ? @"افتح بالمش لمراجعة التنبيه." : @"Open PalMesh to review the alert.";
    content.sound = UNNotificationSound.defaultSound;
    // No message text, coordinates, identity or sender data enters system UI.
    NSString *requestId = [@"palmesh-sos:" stringByAppendingString:identifier];
    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:requestId content:content trigger:nil];
    [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:request withCompletionHandler:^(NSError *error) {
      if (error) reject(@"ALERT_UNAVAILABLE",@"Could not show emergency alert",error); else resolve(nil);
    }];
  }];
}
RCT_REMAP_METHOD(cancelEmergencyNotification, cancelEmergency:(NSString *)identifier resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (![self validId:identifier]) { reject(@"INVALID_ALERT",@"Invalid alert identifier",nil); return; }
  NSArray *identifiers = @[[ @"palmesh-sos:" stringByAppendingString:identifier]];
  [UNUserNotificationCenter.currentNotificationCenter removePendingNotificationRequestsWithIdentifiers:identifiers];
  [UNUserNotificationCenter.currentNotificationCenter removeDeliveredNotificationsWithIdentifiers:identifiers]; resolve(nil);
}
- (void)invalidate {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self stopObserving];
    if (self.batteryMonitoring) UIDevice.currentDevice.batteryMonitoringEnabled = self.previousBatteryMonitoring;
    self.batteryMonitoring = NO;
  });
  [super invalidate];
}
@end
