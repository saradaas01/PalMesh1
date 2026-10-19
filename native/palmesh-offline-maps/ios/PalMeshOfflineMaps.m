#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <CommonCrypto/CommonDigest.h>
#import <Security/Security.h>
#import <sqlite3.h>
#import <zlib.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <arpa/inet.h>
#import <unistd.h>
#import <fcntl.h>
#import <errno.h>
#import <math.h>

static const NSUInteger PMMaxTile = 1024 * 1024;
static NSError *PMError(NSString *message) { return [NSError errorWithDomain:@"PalMeshOfflineMaps" code:1 userInfo:@{NSLocalizedDescriptionKey:message}]; }
static BOOL PMMatches(NSString *value, NSString *pattern) {
  return [value isKindOfClass:NSString.class] && [value rangeOfString:pattern options:NSRegularExpressionSearch].location != NSNotFound;
}
static NSString *PMHex(const unsigned char *bytes, NSUInteger length) {
  NSMutableString *result = [NSMutableString stringWithCapacity:length * 2];
  for (NSUInteger index = 0; index < length; index++) [result appendFormat:@"%02x",bytes[index]];
  return result;
}
static BOOL PMVarint(NSData *data, NSUInteger *offset, uint64_t *value) {
  const uint8_t *bytes = data.bytes; *value = 0;
  for (NSUInteger shift = 0; shift < 63 && *offset < data.length; shift += 7) {
    uint8_t byte = bytes[(*offset)++]; *value |= ((uint64_t)(byte & 127)) << shift;
    if (!(byte & 128)) return YES;
  }
  return NO;
}
/** Bound gzip inflation before checking protobuf Tile layer framing. Geometry
 * is interpreted by MapLibre; this host never treats vector data as code. */
static BOOL PMVectorTile(NSData *stored) {
  if (stored.length < 1 || stored.length > PMMaxTile) return NO;
  NSData *data = stored; const uint8_t *bytes = stored.bytes;
  if (stored.length > 1 && bytes[0] == 31 && bytes[1] == 139) {
    z_stream stream = {0};
    if (inflateInit2(&stream, 16 + MAX_WBITS) != Z_OK) return NO;
    stream.next_in = (Bytef *)stored.bytes; stream.avail_in = (uInt)stored.length;
    NSMutableData *decoded = [NSMutableData new]; uint8_t buffer[16384]; int status;
    do {
      stream.next_out = buffer; stream.avail_out = sizeof(buffer);
      status = inflate(&stream,Z_NO_FLUSH);
      NSUInteger produced = sizeof(buffer) - stream.avail_out;
      if (decoded.length + produced > 4 * 1024 * 1024 || (status != Z_OK && status != Z_STREAM_END)) { inflateEnd(&stream); return NO; }
      [decoded appendBytes:buffer length:produced];
    } while (status != Z_STREAM_END);
    BOOL complete = stream.avail_in == 0; inflateEnd(&stream); if (!complete) return NO;
    data = decoded;
  }
  NSUInteger offset = 0; BOOL layer = NO;
  while (offset < data.length) {
    uint64_t tag, length;
    if (!PMVarint(data,&offset,&tag) || tag == 0 || tag > UINT32_MAX || (tag >> 3) == 0) return NO;
    if (tag == 26) layer = YES;
    switch (tag & 7) {
      case 0: if (!PMVarint(data,&offset,&length)) return NO; continue;
      case 1: length = 8; break;
      case 2: if (!PMVarint(data,&offset,&length)) return NO; break;
      case 5: length = 4; break;
      default: return NO;
    }
    if (length > data.length - offset) return NO;
    offset += (NSUInteger)length;
  }
  return layer;
}
static int PMQueryDeadline(void *context) {
  NSTimeInterval deadline = *(NSTimeInterval *)context;
  return NSProcessInfo.processInfo.systemUptime > deadline;
}

@interface PMTileClient : NSObject
@property(nonatomic) int socket;
@property(nonatomic, strong) NSLock *lock;
- (instancetype)initWithSocket:(int)socket;
- (void)interrupt;
- (void)finish;
@end
@implementation PMTileClient
- (instancetype)initWithSocket:(int)socket { if ((self = [super init])) { _socket = socket; _lock = [NSLock new]; } return self; }
- (void)interrupt { [_lock lock]; if (_socket >= 0) shutdown(_socket,SHUT_RDWR); [_lock unlock]; }
- (void)finish { [_lock lock]; if (_socket >= 0) { close(_socket); _socket = -1; } [_lock unlock]; }
@end

@interface PMTileHost : NSObject {
  sqlite3 *_database;
}
@property(nonatomic, strong) NSLock *databaseLock;
@property(nonatomic, strong) NSLock *clientsLock;
@property(nonatomic, strong) NSMutableSet<PMTileClient *> *clients;
@property(nonatomic, strong) NSOperationQueue *workers;
@property(nonatomic, strong) dispatch_source_t listener;
@property(nonatomic, copy) NSDictionary *descriptor;
@property(nonatomic, copy) NSString *token;
@property(nonatomic) uint16_t port;
@property(nonatomic) NSInteger minZoom;
@property(nonatomic) NSInteger maxZoom;
@property(atomic) BOOL closed;
@property(nonatomic, copy) NSString *fontRoot;
- (instancetype)initWithFile:(NSString *)path error:(NSError **)error;
- (void)close;
@end

@implementation PMTileHost
- (instancetype)initWithFile:(NSString *)path error:(NSError **)error {
  if (!(self = [super init])) return nil;
  _databaseLock = [NSLock new]; _clientsLock = [NSLock new]; _clients = [NSMutableSet new];
  _workers = [NSOperationQueue new]; _workers.maxConcurrentOperationCount = 2;
  int socketFD = -1;
  @try {
    if (sqlite3_open_v2(path.fileSystemRepresentation,&_database,SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX,NULL) != SQLITE_OK) @throw PMError(@"Cannot open bundled MBTiles read-only");
    sqlite3_busy_timeout(_database,3000);
    sqlite3_exec(_database,"PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;",NULL,NULL,NULL);
    NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 5;
    sqlite3_progress_handler(_database,1000,PMQueryDeadline,&deadline);
    sqlite3_stmt *statement = NULL;
    NSMutableDictionary *metadata = [NSMutableDictionary new];
    if (sqlite3_prepare_v2(_database,"SELECT CASE WHEN length(name)<=128 THEN name END, CASE WHEN length(value)<=262144 THEN value END FROM metadata LIMIT 257",-1,&statement,NULL) != SQLITE_OK) @throw PMError(@"MBTiles metadata is missing");
    int step;
    while ((step = sqlite3_step(statement)) == SQLITE_ROW) {
      const char *key = (const char *)sqlite3_column_text(statement,0); const char *value = (const char *)sqlite3_column_text(statement,1);
      NSString *name = key ? [NSString stringWithUTF8String:key] : nil; NSString *text = value ? [NSString stringWithUTF8String:value] : nil;
      if (!name || !text || metadata[name] || metadata.count >= 256) { sqlite3_finalize(statement); @throw PMError(@"Invalid MBTiles metadata"); }
      metadata[name] = text;
    }
    sqlite3_finalize(statement);
    if (step != SQLITE_DONE) @throw PMError(@"Cannot read MBTiles metadata");
    if (![[metadata[@"format"] lowercaseString] isEqualToString:@"pbf"] || (metadata[@"scheme"] && ![[metadata[@"scheme"] lowercaseString] isEqualToString:@"tms"])) @throw PMError(@"Vector PBF MBTiles in TMS scheme required");
    if (!PMMatches(metadata[@"minzoom"],@"^[0-9]{1,2}$") || !PMMatches(metadata[@"maxzoom"],@"^[0-9]{1,2}$")) @throw PMError(@"Invalid MBTiles zoom metadata");
    _minZoom = [metadata[@"minzoom"] integerValue]; _maxZoom = [metadata[@"maxzoom"] integerValue];
    if (_minZoom < 0 || _maxZoom > 22 || _minZoom > _maxZoom) @throw PMError(@"Invalid MBTiles zoom range");
    NSArray *components = [metadata[@"bounds"] componentsSeparatedByString:@","];
    if (components.count != 4) @throw PMError(@"MBTiles bounds are required");
    NSMutableArray *bounds = [NSMutableArray new];
    for (NSString *component in components) {
      NSScanner *scanner = [NSScanner scannerWithString:component]; double coordinate;
      if (![scanner scanDouble:&coordinate] || !scanner.isAtEnd || !isfinite(coordinate)) @throw PMError(@"Invalid MBTiles bounds");
      [bounds addObject:@(coordinate)];
    }
    if ([bounds[0] doubleValue] < -180 || [bounds[2] doubleValue] > 180 || [bounds[1] doubleValue] < -90 || [bounds[3] doubleValue] > 90 || [bounds[0] doubleValue] >= [bounds[2] doubleValue] || [bounds[1] doubleValue] >= [bounds[3] doubleValue]) @throw PMError(@"Invalid MBTiles bounds");
    if (![metadata[@"json"] isKindOfClass:NSString.class]) @throw PMError(@"MBTiles vector layer metadata is missing");
    NSDictionary *json = [NSJSONSerialization JSONObjectWithData:[metadata[@"json"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    NSArray *vectorLayers = [json isKindOfClass:NSDictionary.class] ? json[@"vector_layers"] : nil;
    if (![vectorLayers isKindOfClass:NSArray.class] || vectorLayers.count < 1 || vectorLayers.count > 128) @throw PMError(@"Invalid MBTiles vector layers");
    NSMutableArray *layers = [NSMutableArray new];
    for (id object in vectorLayers) {
      NSString *name = [object isKindOfClass:NSDictionary.class] ? object[@"id"] : nil;
      if (!PMMatches(name,@"^[A-Za-z_][A-Za-z0-9_-]{0,127}$") || [layers containsObject:name]) @throw PMError(@"Invalid MBTiles source layer");
      [layers addObject:name];
    }
    NSString *attribution = metadata[@"attribution"] ?: @"";
    if (attribution.length > 8192) @throw PMError(@"MBTiles attribution is too large");
    attribution = [attribution stringByReplacingOccurrencesOfString:@"<[^>]*>" withString:@"" options:NSRegularExpressionSearch range:NSMakeRange(0,attribution.length)];
    attribution = [[attribution stringByReplacingOccurrencesOfString:@"&copy;" withString:@"©"] stringByReplacingOccurrencesOfString:@"&amp;" withString:@"&"];
    attribution = [attribution stringByReplacingOccurrencesOfString:@"[<>\\p{Cntrl}]" withString:@" " options:NSRegularExpressionSearch range:NSMakeRange(0,attribution.length)];
    if (attribution.length > 1024) @throw PMError(@"MBTiles attribution is too large");
    if (sqlite3_prepare_v2(_database,"SELECT tile_data FROM tiles WHERE length(tile_data) BETWEEN 1 AND 1048576 LIMIT 1",-1,&statement,NULL) != SQLITE_OK) @throw PMError(@"MBTiles tiles are missing");
    BOOL valid = sqlite3_step(statement) == SQLITE_ROW;
    if (valid) valid = PMVectorTile([NSData dataWithBytes:sqlite3_column_blob(statement,0) length:(NSUInteger)sqlite3_column_bytes(statement,0)]);
    sqlite3_finalize(statement);
    sqlite3_progress_handler(_database,0,NULL,NULL);
    if (!valid) @throw PMError(@"MBTiles has no valid vector tile data");
    unsigned char random[16]; if (SecRandomCopyBytes(kSecRandomDefault,sizeof(random),random) != errSecSuccess) @throw PMError(@"Cannot generate tile session token");
    _token = PMHex(random,sizeof(random));
    socketFD = socket(AF_INET,SOCK_STREAM,0);
    if (socketFD < 0) @throw PMError(@"Cannot create loopback tile socket");
    int one = 1; setsockopt(socketFD,SOL_SOCKET,SO_NOSIGPIPE,&one,sizeof(one));
    struct sockaddr_in address = {0}; address.sin_len = sizeof(address); address.sin_family = AF_INET; address.sin_port = 0; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(socketFD,(struct sockaddr *)&address,sizeof(address)) || listen(socketFD,16)) @throw PMError(@"Cannot bind loopback tile socket");
    socklen_t length = sizeof(address); if (getsockname(socketFD,(struct sockaddr *)&address,&length)) @throw PMError(@"Cannot inspect loopback tile socket");
    _port = ntohs(address.sin_port); fcntl(socketFD,F_SETFL,fcntl(socketFD,F_GETFL,0) | O_NONBLOCK);
    NSMutableDictionary *descriptor = [@{@"tileUrlTemplate":[NSString stringWithFormat:@"http://127.0.0.1:%u/%@/{z}/{x}/{y}.pbf",_port,_token],@"bounds":bounds,@"minZoom":@(_minZoom),@"maxZoom":@(_maxZoom),@"sourceLayers":layers,@"attribution":attribution} mutableCopy];
    _fontRoot = [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"palmesh/fonts/Klokantech Noto Sans Regular"];
    if ([NSFileManager.defaultManager fileExistsAtPath:[_fontRoot stringByAppendingPathComponent:@"0-255.pbf"]]) descriptor[@"glyphUrlTemplate"] = [NSString stringWithFormat:@"http://127.0.0.1:%u/%@/fonts/{fontstack}/{range}.pbf",_port,_token];
    _descriptor = descriptor;
    int listenerFD = socketFD;
    _listener = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ,(uintptr_t)listenerFD,0,dispatch_queue_create("org.palmesh.tiles.accept",DISPATCH_QUEUE_SERIAL));
    __weak PMTileHost *weakSelf = self;
    dispatch_source_set_event_handler(_listener,^{ [weakSelf accept:listenerFD]; });
    dispatch_source_set_cancel_handler(_listener,^{ close(listenerFD); }); dispatch_resume(_listener);
    return self;
  } @catch (NSError *failure) {
    if (socketFD >= 0) close(socketFD);
    if (_database) { sqlite3_close_v2(_database); _database = NULL; }
    if (error) *error = failure;
    return nil;
  }
}
- (void)accept:(int)listener {
  while (YES) {
    struct sockaddr_in address; socklen_t length = sizeof(address);
    int clientFD = accept(listener,(struct sockaddr *)&address,&length);
    if (clientFD < 0) return;
    int one = 1; setsockopt(clientFD,SOL_SOCKET,SO_NOSIGPIPE,&one,sizeof(one));
    struct timeval timeout = {3,0}; setsockopt(clientFD,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout)); setsockopt(clientFD,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
    PMTileClient *client = [[PMTileClient alloc] initWithSocket:clientFD];
    [_clientsLock lock]; BOOL reject = _closed || _clients.count >= 18 || address.sin_addr.s_addr != htonl(INADDR_LOOPBACK);
    if (!reject) [_clients addObject:client]; [_clientsLock unlock];
    if (reject) { [client finish]; continue; }
    __weak PMTileClient *weakClient = client;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,5 * NSEC_PER_SEC),dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{ [weakClient interrupt]; });
    [_workers addOperationWithBlock:^{ @autoreleasepool { [self serve:client]; } }];
  }
}
- (void)respond:(PMTileClient *)client status:(NSInteger)status data:(NSData *)data contentType:(NSString *)contentType {
  NSData *body = data ?: [NSData data]; const uint8_t *bytes = body.bytes;
  BOOL gzip = body.length > 1 && bytes[0] == 31 && bytes[1] == 139;
  NSString *header = [NSString stringWithFormat:@"HTTP/1.1 %ld %@\r\nContent-Type: %@\r\nContent-Length: %lu\r\n%@Cache-Control: private, max-age=86400\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n",(long)status,status == 200 ? @"OK" : status == 404 ? @"Not Found" : @"Bad Request",contentType,(unsigned long)body.length,gzip ? @"Content-Encoding: gzip\r\n" : @""];
  for (NSData *part in @[[header dataUsingEncoding:NSASCIIStringEncoding],body]) {
    NSUInteger offset = 0; while (offset < part.length) {
      ssize_t count = send(client.socket,(const uint8_t *)part.bytes + offset,part.length - offset,0);
      if (count <= 0) return; offset += (NSUInteger)count;
    }
  }
}
- (void)serve:(PMTileClient *)client {
  @try {
    NSMutableData *request = [NSMutableData new]; uint8_t byte; BOOL ended = NO;
    while (request.length < 8192) {
      if (recv(client.socket,&byte,1,0) != 1 || byte > 127 || (byte < 32 && byte != 13 && byte != 10 && byte != 9)) return;
      [request appendBytes:&byte length:1];
      if (request.length >= 4 && memcmp((uint8_t *)request.bytes + request.length - 4,"\r\n\r\n",4) == 0) { ended = YES; break; }
    }
    if (!ended) return;
    NSString *headers = [[NSString alloc] initWithData:request encoding:NSASCIIStringEncoding];
    NSArray *lines = [headers componentsSeparatedByString:@"\r\n"]; NSArray *first = [lines[0] componentsSeparatedByString:@" "];
    if (first.count != 3 || ![first[0] isEqual:@"GET"] || ![first[2] isEqual:@"HTTP/1.1"]) { [self respond:client status:400 data:nil contentType:@"application/octet-stream"]; return; }
    BOOL validHost = NO;
    for (NSString *line in [lines subarrayWithRange:NSMakeRange(1,lines.count - 1)]) if ([[line lowercaseString] hasPrefix:@"host:"]) {
      NSString *host = [[line substringFromIndex:5] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
      if (validHost || ![host isEqual:[NSString stringWithFormat:@"127.0.0.1:%u",_port]]) { [self respond:client status:400 data:nil contentType:@"application/octet-stream"]; return; }
      validHost = YES;
    }
    NSString *path = first[1]; NSString *prefix = [NSString stringWithFormat:@"/%@/",_token];
    if (!validHost || ![path hasPrefix:prefix]) { [self respond:client status:404 data:nil contentType:@"application/octet-stream"]; return; }
    NSString *tail = [path substringFromIndex:prefix.length]; NSData *data = nil; NSString *contentType = @"application/vnd.mapbox-vector-tile";
    if (PMMatches(tail,@"^[0-9]{1,2}/[0-9]{1,7}/[0-9]{1,7}\\.pbf$")) {
      NSArray *coordinates = [tail componentsSeparatedByString:@"/"]; NSInteger zoom = [coordinates[0] integerValue]; uint64_t x = [coordinates[1] longLongValue], y = [coordinates[2] longLongValue];
      if (zoom >= _minZoom && zoom <= _maxZoom && zoom <= 22 && x < (1ULL << zoom) && y < (1ULL << zoom)) {
        [_databaseLock lock];
        if (_database && !_closed) {
          NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 3;
          sqlite3_progress_handler(_database,1000,PMQueryDeadline,&deadline);
          sqlite3_stmt *statement = NULL;
          if (sqlite3_prepare_v2(_database,"SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=? AND length(tile_data) BETWEEN 1 AND 1048576 LIMIT 1",-1,&statement,NULL) == SQLITE_OK) {
            sqlite3_bind_int64(statement,1,zoom); sqlite3_bind_int64(statement,2,x); sqlite3_bind_int64(statement,3,(1ULL << zoom) - 1 - y);
            if (sqlite3_step(statement) == SQLITE_ROW) data = [NSData dataWithBytes:sqlite3_column_blob(statement,0) length:(NSUInteger)sqlite3_column_bytes(statement,0)];
          }
          sqlite3_finalize(statement); sqlite3_progress_handler(_database,0,NULL,NULL);
        }
        [_databaseLock unlock];
        if (data && !PMVectorTile(data)) data = nil;
      }
    } else {
      NSString *decoded = tail.stringByRemovingPercentEncoding;
      if ([decoded hasPrefix:@"fonts/Klokantech Noto Sans Regular/"]) {
        NSString *range = [decoded substringFromIndex:@"fonts/Klokantech Noto Sans Regular/".length];
        if (PMMatches(range,@"^[0-9]{1,5}-[0-9]{1,5}\\.pbf$")) {
          NSArray *values = [[range stringByDeletingPathExtension] componentsSeparatedByString:@"-"];
          NSInteger low = [values[0] integerValue], high = [values[1] integerValue];
          if (low % 256 == 0 && high == low + 255 && high <= 65535) {
            NSString *file = [_fontRoot stringByAppendingPathComponent:range];
            NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:file error:nil];
            if ([attributes fileSize] > 0 && [attributes fileSize] <= PMMaxTile) data = [NSData dataWithContentsOfFile:file options:0 error:nil];
            contentType = @"application/x-protobuf";
          }
        }
      }
    }
    [self respond:client status:data ? 200 : 404 data:data contentType:contentType];
  } @finally {
    [client finish]; [_clientsLock lock]; [_clients removeObject:client]; [_clientsLock unlock];
  }
}
- (void)close {
  [_clientsLock lock]; if (_closed) { [_clientsLock unlock]; return; } _closed = YES;
  NSArray *clients = _clients.allObjects; [_clientsLock unlock];
  if (_listener) { dispatch_source_cancel(_listener); _listener = nil; }
  for (PMTileClient *client in clients) [client interrupt];
  // Interrupt an expensive query before acquiring its connection lock.
  if (_database) sqlite3_interrupt(_database);
  [_databaseLock lock]; if (_database) { sqlite3_close_v2(_database); _database = NULL; } [_databaseLock unlock];
}
- (void)dealloc { [self close]; }
@end

@interface PalMeshOfflineMaps : NSObject <RCTBridgeModule>
@property(nonatomic, strong) PMTileHost *host;
@end
@implementation PalMeshOfflineMaps
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
RCT_REMAP_METHOD(open, openOptions:(NSDictionary *)options resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self.host close]; self.host = nil;
  NSString *asset = options[@"assetName"]; NSString *expected = options[@"expectedSha256"];
  if (!PMMatches(asset,@"^palmesh/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\\.mbtiles$") || (expected && !PMMatches(expected,@"^[a-fA-F0-9]{64}$"))) { reject(@"invalid",@"Invalid bundled map options",nil); return; }
  NSString *file = [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:asset];
  NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:file error:nil];
  if (![attributes[NSFileType] isEqual:NSFileTypeRegular] || [attributes fileSize] < 1 || [attributes fileSize] > 8ULL * 1024 * 1024 * 1024) { reject(@"asset-unavailable",@"Bundled MBTiles asset is missing or exceeds the size limit",nil); return; }
  if (expected) {
    NSInputStream *input = [NSInputStream inputStreamWithFileAtPath:file]; [input open];
    CC_SHA256_CTX context; CC_SHA256_Init(&context); uint8_t buffer[65536]; NSInteger count;
    while ((count = [input read:buffer maxLength:sizeof(buffer)]) > 0) CC_SHA256_Update(&context,buffer,(CC_LONG)count);
    [input close]; unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256_Final(digest,&context);
    if (count < 0 || ![[PMHex(digest,sizeof(digest)) lowercaseString] isEqual:expected.lowercaseString]) { reject(@"checksum",@"Bundled MBTiles checksum mismatch",nil); return; }
  }
  NSError *error = nil; self.host = [[PMTileHost alloc] initWithFile:file error:&error];
  if (!self.host) { reject(@"invalid-map",error.localizedDescription ?: @"Cannot open offline map",error); return; }
  resolve(self.host.descriptor);
}
RCT_REMAP_METHOD(close, closeWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) { [self.host close]; self.host = nil; resolve(nil); }
- (void)invalidate { [self.host close]; self.host = nil; }
@end
