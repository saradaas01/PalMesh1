#import <CoreBluetooth/CoreBluetooth.h>
#import <React/RCTEventEmitter.h>

static NSString *const PMService = @"c62d6a00-7e41-4cc2-9d31-c7a81ef11310";
static NSString *const PMWrite = @"c62d6a01-7e41-4cc2-9d31-c7a81ef11310";
static NSString *const PMNotify = @"c62d6a02-7e41-4cc2-9d31-c7a81ef11310";

@interface PMBleWrite : NSObject
@property(nonatomic, copy) NSString *operation;
@property(nonatomic, copy) NSString *linkId;
@property(nonatomic, strong) NSData *data;
@property(nonatomic, copy) RCTPromiseResolveBlock resolve;
@property(nonatomic, copy) RCTPromiseRejectBlock reject;
@end
@implementation PMBleWrite
@end

/** GATT peripheral half of the existing BLE PLX central adapter. All mutable
 * state lives on the main queue; accepted writes mean queued notifications,
 * never remote persistence (the DTN protocol supplies its own acknowledgments). */
@interface PalMeshBlePeripheral : RCTEventEmitter <CBPeripheralManagerDelegate>
@property(nonatomic, strong) CBPeripheralManager *manager;
@property(nonatomic, strong) CBMutableCharacteristic *receiveCharacteristic;
@property(nonatomic, strong) CBMutableCharacteristic *notifyCharacteristic;
@property(nonatomic, strong) NSMutableDictionary<NSString *, CBCentral *> *centrals;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *links;
@property(nonatomic, strong) NSMutableSet<NSString *> *revoked;
@property(nonatomic, strong) NSMutableArray<PMBleWrite *> *writes;
@property(nonatomic, copy) RCTPromiseResolveBlock startResolve;
@property(nonatomic, copy) RCTPromiseRejectBlock startReject;
@property(nonatomic, copy) NSString *startOperation;
@property(nonatomic) BOOL running;
@property(nonatomic) BOOL observing;
@end

@implementation PalMeshBlePeripheral
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (NSArray<NSString *> *)supportedEvents { return @[@"PalMeshBlePeripheralEvent"]; }
- (void)startObserving { _observing = YES; }
- (void)stopObserving { _observing = NO; }
- (void)emit:(NSDictionary *)event { if (_observing) [self sendEventWithName:@"PalMeshBlePeripheralEvent" body:event]; }
- (NSDictionary *)status {
  if (CBManager.authorization != CBManagerAuthorizationAllowedAlways) return @{@"available":@NO,@"reason":@"permission-denied"};
  if (!_manager || _manager.state == CBManagerStatePoweredOn) return @{@"available":@YES};
  NSString *reason = _manager.state == CBManagerStatePoweredOff ? @"powered-off"
    : _manager.state == CBManagerStateUnsupported ? @"unsupported" : @"unavailable";
  return @{@"available":@NO,@"reason":reason};
}
RCT_REMAP_METHOD(getStatus, statusWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { resolve([self status]); }
RCT_REMAP_METHOD(start, startOperation:(NSString *)operation resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (CBManager.authorization != CBManagerAuthorizationAllowedAlways) { reject(@"permission-denied",@"Enable Bluetooth permission before discovery",nil); return; }
  if (operation.length < 1 || operation.length > 256) { reject(@"invalid",@"Invalid operation",nil); return; }
  if (_running) { resolve(nil); return; }
  _running = YES; _centrals = [NSMutableDictionary new]; _links = [NSMutableDictionary new];
  _revoked = [NSMutableSet new]; _writes = [NSMutableArray new];
  _startOperation = operation; _startResolve = resolve; _startReject = reject;
  // No restoration identifier: iOS may suspend JavaScript; this is not a daemon.
  _manager = [[CBPeripheralManager alloc] initWithDelegate:self queue:dispatch_get_main_queue()
    options:@{CBPeripheralManagerOptionShowPowerAlertKey:@NO}];
}
- (void)failStart:(NSString *)message {
  RCTPromiseRejectBlock reject = _startReject; _startReject = nil; _startResolve = nil; _startOperation = nil;
  if (reject) reject(@"unavailable", message, nil);
  [self cleanup];
}
- (void)peripheralManagerDidUpdateState:(CBPeripheralManager *)peripheral {
  if (!_running || peripheral != _manager) return;
  if (peripheral.state == CBManagerStateUnknown) return;
  if (peripheral.state == CBManagerStateResetting && _startResolve) return;
  if (peripheral.state != CBManagerStatePoweredOn) {
    [self emit:@{@"type":@"status",@"status":[self status]}];
    [self failStart:@"Bluetooth peripheral is unavailable"]; return;
  }
  _receiveCharacteristic = [[CBMutableCharacteristic alloc] initWithType:[CBUUID UUIDWithString:PMWrite]
    properties:CBCharacteristicPropertyWrite value:nil permissions:CBAttributePermissionsWriteable];
  _notifyCharacteristic = [[CBMutableCharacteristic alloc] initWithType:[CBUUID UUIDWithString:PMNotify]
    properties:CBCharacteristicPropertyNotify value:nil permissions:CBAttributePermissionsReadable];
  CBMutableService *service = [[CBMutableService alloc] initWithType:[CBUUID UUIDWithString:PMService] primary:YES];
  service.characteristics = @[_receiveCharacteristic,_notifyCharacteristic];
  [peripheral addService:service];
}
- (void)peripheralManager:(CBPeripheralManager *)peripheral didAddService:(CBService *)service error:(NSError *)error {
  if (!_running || peripheral != _manager) return;
  if (error) { [self failStart:@"Could not register PalMesh BLE service"]; return; }
  [peripheral startAdvertising:@{CBAdvertisementDataServiceUUIDsKey:@[[CBUUID UUIDWithString:PMService]]}];
}
- (void)peripheralManagerDidStartAdvertising:(CBPeripheralManager *)peripheral error:(NSError *)error {
  if (!_running || peripheral != _manager) return;
  if (error) { [self failStart:@"Could not advertise PalMesh BLE service"]; return; }
  RCTPromiseResolveBlock resolve = _startResolve; _startResolve = nil; _startReject = nil; _startOperation = nil;
  if (resolve) resolve(nil);
}
- (void)peripheralManager:(CBPeripheralManager *)peripheral central:(CBCentral *)central didSubscribeToCharacteristic:(CBCharacteristic *)characteristic {
  if (!_running || peripheral != _manager || ![characteristic.UUID isEqual:_notifyCharacteristic.UUID]) return;
  NSString *endpoint = central.identifier.UUIDString;
  if (_links[endpoint] || [_revoked containsObject:endpoint]) return;
  if (_links.count >= 8) { [_revoked addObject:endpoint]; return; }
  NSUInteger chunk = MIN((NSUInteger)512,central.maximumUpdateValueLength);
  if (chunk < 20) { [_revoked addObject:endpoint]; return; }
  NSDictionary *link = @{@"id":[@"ios-peripheral-" stringByAppendingString:NSUUID.UUID.UUIDString],@"endpointId":endpoint,@"maxChunkBytes":@(chunk)};
  _centrals[endpoint] = central; _links[endpoint] = link;
  [self emit:@{@"type":@"connected",@"link":link}];
}
- (void)peripheralManager:(CBPeripheralManager *)peripheral central:(CBCentral *)central didUnsubscribeFromCharacteristic:(CBCharacteristic *)characteristic {
  if (peripheral != _manager || ![characteristic.UUID isEqual:_notifyCharacteristic.UUID]) return;
  [self releaseCentral:central.identifier.UUIDString]; [_revoked removeObject:central.identifier.UUIDString];
}
- (void)peripheralManager:(CBPeripheralManager *)peripheral didReceiveWriteRequests:(NSArray<CBATTRequest *> *)requests {
  if (requests.count == 0) return;
  // A write-with-response batch is atomic: validate every request before emitting.
  CBATTError result = CBATTErrorSuccess;
  for (CBATTRequest *request in requests) {
    NSDictionary *link = _links[request.central.identifier.UUIDString];
    if (!_running || peripheral != _manager || !link) { result = CBATTErrorUnlikelyError; break; }
    if (![request.characteristic.UUID isEqual:_receiveCharacteristic.UUID]) { result = CBATTErrorWriteNotPermitted; break; }
    if (request.offset != 0) { result = CBATTErrorInvalidOffset; break; }
    if (request.value.length < 1 || request.value.length > [link[@"maxChunkBytes"] unsignedIntegerValue]) { result = CBATTErrorInvalidAttributeValueLength; break; }
  }
  if (result == CBATTErrorSuccess) for (CBATTRequest *request in requests) {
    NSDictionary *link = _links[request.central.identifier.UUIDString];
    [self emit:@{@"type":@"data",@"linkId":link[@"id"],@"base64":[request.value base64EncodedStringWithOptions:0]}];
  }
  [peripheral respondToRequest:requests.firstObject withResult:result];
}
RCT_REMAP_METHOD(connect, connectEndpoint:(NSString *)endpoint operation:(NSString *)operation resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  reject(@"unsupported",@"BLE peripheral accepts inbound connections only",nil);
}
- (NSString *)endpointForLink:(NSString *)linkId {
  for (NSString *endpoint in _links) if ([_links[endpoint][@"id"] isEqual:linkId]) return endpoint;
  return nil;
}
RCT_REMAP_METHOD(write, writeLink:(NSString *)linkId base64:(NSString *)base64 operation:(NSString *)operation resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *endpoint = [self endpointForLink:linkId]; NSDictionary *link = endpoint ? _links[endpoint] : nil;
  if (!_running || !link) { reject(@"closed",@"BLE link is closed",nil); return; }
  if (base64.length > 684 || operation.length < 1 || operation.length > 256) { reject(@"invalid",@"Invalid BLE write",nil); return; }
  NSData *data = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
  if (data.length < 1 || data.length > [link[@"maxChunkBytes"] unsignedIntegerValue]) { reject(@"invalid",@"BLE write exceeds negotiated limit",nil); return; }
  if (_writes.count >= 64) { reject(@"busy",@"BLE notification queue is full",nil); return; }
  PMBleWrite *write = [PMBleWrite new]; write.linkId = linkId; write.operation = operation; write.data = data; write.resolve = resolve; write.reject = reject;
  [_writes addObject:write]; [self drainWrites];
}
- (void)drainWrites {
  while (_running && _writes.count) {
    PMBleWrite *write = _writes.firstObject;
    NSString *endpoint = [self endpointForLink:write.linkId]; CBCentral *central = endpoint ? _centrals[endpoint] : nil;
    if (!central) { [_writes removeObjectAtIndex:0]; write.reject(@"closed",@"BLE link closed",nil); continue; }
    if (![_manager updateValue:write.data forCharacteristic:_notifyCharacteristic onSubscribedCentrals:@[central]]) return;
    [_writes removeObjectAtIndex:0]; write.resolve(nil);
  }
}
- (void)peripheralManagerIsReadyToUpdateSubscribers:(CBPeripheralManager *)peripheral { if (peripheral == _manager) [self drainWrites]; }
RCT_EXPORT_METHOD(cancel:(NSString *)operation) {
  if ([_startOperation isEqual:operation]) { [self failStart:@"BLE start cancelled"]; return; }
  for (PMBleWrite *write in [_writes copy]) if ([write.operation isEqual:operation]) {
    [_writes removeObject:write]; write.reject(@"cancelled",@"BLE write cancelled",nil);
  }
}
- (void)releaseCentral:(NSString *)endpoint {
  NSDictionary *link = _links[endpoint]; if (!link) return;
  [_links removeObjectForKey:endpoint]; [_centrals removeObjectForKey:endpoint];
  for (PMBleWrite *write in [_writes copy]) if ([write.linkId isEqual:link[@"id"]]) {
    [_writes removeObject:write]; write.reject(@"closed",@"BLE central disconnected",nil);
  }
  [self emit:@{@"type":@"disconnected",@"linkId":link[@"id"]}];
}
RCT_REMAP_METHOD(disconnect, disconnectLink:(NSString *)linkId resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *endpoint = [self endpointForLink:linkId];
  if (endpoint) { [_revoked addObject:endpoint]; [self releaseCentral:endpoint]; }
  // CoreBluetooth peripherals cannot forcibly disconnect a remote central.
  // Revoke the logical session until that central unsubscribes instead.
  resolve(nil);
}
- (void)cleanup {
  RCTPromiseRejectBlock pending = _startReject; _startResolve = nil; _startReject = nil; _startOperation = nil;
  if (pending) pending(@"cancelled",@"BLE stopped",nil);
  _running = NO; [_manager stopAdvertising]; [_manager removeAllServices];
  _manager.delegate = nil; _manager = nil;
  for (NSString *endpoint in [_links.allKeys copy]) [self releaseCentral:endpoint];
  for (PMBleWrite *write in [_writes copy]) write.reject(@"cancelled",@"BLE stopped",nil);
  [_writes removeAllObjects]; [_revoked removeAllObjects];
  _receiveCharacteristic = nil; _notifyCharacteristic = nil;
}
RCT_REMAP_METHOD(stop, stopWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  RCTPromiseRejectBlock pending = _startReject; _startResolve = nil; _startReject = nil; _startOperation = nil;
  if (pending) pending(@"cancelled",@"BLE stopped",nil);
  [self cleanup]; resolve(nil);
}
- (void)invalidate { dispatch_async(dispatch_get_main_queue(), ^{ [self cleanup]; }); [super invalidate]; }
@end
