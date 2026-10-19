#import <CoreBluetooth/CoreBluetooth.h>
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>

/** Checking the class authorization property does not instantiate CoreBluetooth
 * or prompt. A central manager is constructed only after the user's Enable tap. */
@interface PalMeshBluetoothAuthorization : NSObject <RCTBridgeModule, CBCentralManagerDelegate>
@property(nonatomic, strong) CBCentralManager *manager;
@property(nonatomic, strong) NSMutableArray *pending;
@end

@implementation PalMeshBluetoothAuthorization
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSString *)authorization {
  switch (CBManager.authorization) {
    case CBManagerAuthorizationAllowedAlways: return @"granted";
    case CBManagerAuthorizationNotDetermined: return @"not-determined";
    case CBManagerAuthorizationRestricted: return @"restricted";
    case CBManagerAuthorizationDenied: return @"denied";
  }
  return @"restricted";
}
RCT_REMAP_METHOD(check, checkWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve([self authorization]);
}
RCT_REMAP_METHOD(request, requestWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *authorization = [self authorization];
  if (![authorization isEqualToString:@"not-determined"]) { resolve(authorization); return; }
  if (UIApplication.sharedApplication.applicationState != UIApplicationStateActive) {
    reject(@"FOREGROUND_REQUIRED",@"Enable Bluetooth from the open app",nil); return;
  }
  if (!_pending) _pending = [NSMutableArray new];
  [_pending addObject:[resolve copy]];
  if (!_manager) _manager = [[CBCentralManager alloc] initWithDelegate:self queue:dispatch_get_main_queue()
    options:@{CBCentralManagerOptionShowPowerAlertKey: @NO}];
}
- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
  NSString *authorization = [self authorization];
  if ([authorization isEqualToString:@"not-determined"]) return;
  NSArray *pending = [_pending copy]; [_pending removeAllObjects];
  for (RCTPromiseResolveBlock resolve in pending) resolve(authorization);
  _manager.delegate = nil; _manager = nil;
}
- (void)invalidate {
  dispatch_async(dispatch_get_main_queue(), ^{
    for (RCTPromiseResolveBlock resolve in self.pending) resolve(@"denied");
    [self.pending removeAllObjects]; self.manager.delegate = nil; self.manager = nil;
  });
}
@end
