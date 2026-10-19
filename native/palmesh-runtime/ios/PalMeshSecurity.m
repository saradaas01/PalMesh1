#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <Security/Security.h>
#import <math.h>

/** Non-synchronizing Keychain records are bound to this device and remain
 * unavailable until its first unlock after reboot. Never fall back to files,
 * defaults or a replacement identity when Keychain access fails. */
@interface PalMeshSecurity : NSObject <RCTBridgeModule>
@end
@implementation PalMeshSecurity
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
- (BOOL)validKey:(NSString *)key {
  if (![key isKindOfClass:NSString.class]) return NO;
  NSRange match = [key rangeOfString:@"^[A-Za-z0-9._:-]{1,128}$" options:NSRegularExpressionSearch];
  // ICU's `$` may match before a final newline; account names must match fully.
  return match.location == 0 && match.length == key.length;
}
- (NSMutableDictionary *)query:(NSString *)key {
  NSString *service = [[NSBundle.mainBundle bundleIdentifier] stringByAppendingString:@".palmesh.vault.v1"];
  return [@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService:service,
    (__bridge id)kSecAttrAccount:key,
    (__bridge id)kSecAttrSynchronizable:@NO} mutableCopy];
}
- (NSData *)readRecord:(NSString *)key status:(OSStatus *)status {
  NSMutableDictionary *query = [self query:key]; query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef result = NULL; *status = SecItemCopyMatching((__bridge CFDictionaryRef)query,&result);
  if (*status != errSecSuccess) { if (result) CFRelease(result); return nil; }
  return CFBridgingRelease(result);
}
RCT_REMAP_METHOD(read, readKey:(NSString *)key resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (![self validKey:key]) { reject(@"INVALID_SECURE_KEY",@"Invalid secure key name",nil); return; }
  OSStatus status; NSData *data = [self readRecord:key status:&status];
  if (status == errSecItemNotFound) { resolve(NSNull.null); return; }
  if (status != errSecSuccess || ![data isKindOfClass:NSData.class] || data.length > 1024 * 1024) {
    reject(@"SECURE_VAULT_UNAVAILABLE",@"Keychain record could not be opened; existing keys were not replaced",nil); return;
  }
  NSString *value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (!value) { reject(@"SECURE_VAULT_UNAVAILABLE",@"Keychain record has invalid encoding",nil); return; }
  resolve(value);
}
RCT_REMAP_METHOD(write, writeKey:(NSString *)key value:(NSString *)value resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSData *data = [value isKindOfClass:NSString.class] ? [value dataUsingEncoding:NSUTF8StringEncoding] : nil;
  if (![self validKey:key] || !data || data.length > 1024 * 1024) { reject(@"INVALID_SECURE_VALUE",@"Invalid secure record",nil); return; }
  OSStatus status; NSData *previous = [self readRecord:key status:&status];
  if (status != errSecSuccess && status != errSecItemNotFound) { reject(@"SECURE_VAULT_UNAVAILABLE",@"Keychain is unavailable; existing keys were not replaced",nil); return; }
  if (status == errSecSuccess && (![previous isKindOfClass:NSData.class] || previous.length > 1024 * 1024 || ![[NSString alloc] initWithData:previous encoding:NSUTF8StringEncoding])) {
    reject(@"SECURE_VAULT_UNAVAILABLE",@"Refusing to overwrite an unreadable secure record",nil); return;
  }
  NSMutableDictionary *query = [self query:key];
  NSDictionary *attributes = @{(__bridge id)kSecValueData:data,
    (__bridge id)kSecAttrAccessible:(__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly};
  if (status == errSecItemNotFound) { [query addEntriesFromDictionary:attributes]; status = SecItemAdd((__bridge CFDictionaryRef)query,NULL); }
  else status = SecItemUpdate((__bridge CFDictionaryRef)query,(__bridge CFDictionaryRef)attributes);
  if (status != errSecSuccess) { reject(@"SECURE_VAULT_UNAVAILABLE",@"Keychain record could not be saved; plaintext storage is disabled",nil); return; }
  resolve(nil);
}
RCT_REMAP_METHOD(randomBytes, randomCount:(double)count resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (!isfinite(count) || count != floor(count) || count < 1 || count > 4096) { reject(@"INVALID_RANDOM_LENGTH",@"Random length must be an integer from 1 to 4096",nil); return; }
  NSMutableData *bytes = [NSMutableData dataWithLength:(NSUInteger)count];
  if (SecRandomCopyBytes(kSecRandomDefault,bytes.length,bytes.mutableBytes) != errSecSuccess) {
    [bytes resetBytesInRange:NSMakeRange(0,bytes.length)]; reject(@"RANDOM_UNAVAILABLE",@"Secure random source is unavailable",nil); return;
  }
  NSString *base64 = [bytes base64EncodedStringWithOptions:0]; [bytes resetBytesInRange:NSMakeRange(0,bytes.length)]; resolve(base64);
}
@end
