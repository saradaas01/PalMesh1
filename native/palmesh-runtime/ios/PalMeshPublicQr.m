#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <PhotosUI/PhotosUI.h>
#import <CoreImage/CoreImage.h>
#import <ImageIO/ImageIO.h>
#import <AVFoundation/AVFoundation.h>
#import "PalMeshCameraController.h"

@interface PalMeshPublicQr : NSObject <RCTBridgeModule, PHPickerViewControllerDelegate>
@property(nonatomic,copy) RCTPromiseResolveBlock resolve;
@property(nonatomic,copy) RCTPromiseRejectBlock reject;
@property(nonatomic,strong) NSProgress *progress;
@property(nonatomic) NSUInteger generation;
@end
@implementation PalMeshPublicQr
RCT_EXPORT_MODULE()
+ (BOOL)requiresMainQueueSetup { return NO; }
- (void)finish:(NSString *)text error:(BOOL)error {
  RCTPromiseResolveBlock resolve=self.resolve; RCTPromiseRejectBlock reject=self.reject;
  self.resolve=nil; self.reject=nil; self.generation++;
  [self.progress cancel]; self.progress=nil;
  if (!resolve) return;
  if (error) reject(@"QR_INVALID_IMAGE",@"Choose a clear locally available image containing one public identity QR",nil);
  else resolve(text);
}
RCT_REMAP_METHOD(scanImage, scanResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(),^{
    UIViewController *presenter=RCTPresentedViewController();
    if (self.resolve || !presenter) { reject(@"QR_UNAVAILABLE",@"Image selection unavailable or busy",nil); return; }
    self.resolve=resolve; self.reject=reject; self.generation++;
    PHPickerConfiguration *configuration=[[PHPickerConfiguration alloc] init];
    configuration.filter=PHPickerFilter.imagesFilter; configuration.selectionLimit=1;
    PHPickerViewController *picker=[[PHPickerViewController alloc] initWithConfiguration:configuration];
    picker.delegate=self; [presenter presentViewController:picker animated:YES completion:nil];
  });
}
RCT_REMAP_METHOD(copyFingerprint, copyValue:(NSString *)fingerprint resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
 if(!fingerprint||fingerprint.length!=68||![NSRegularExpression regularExpressionWithPattern:@"^pm1:[0-9a-f]{64}$" options:0 error:nil]||[[NSRegularExpression regularExpressionWithPattern:@"^pm1:[0-9a-f]{64}$" options:0 error:nil] numberOfMatchesInString:fingerprint options:0 range:NSMakeRange(0,fingerprint.length)]!=1){reject(@"INVALID_FINGERPRINT",@"Invalid public fingerprint",nil);return;}
 dispatch_async(dispatch_get_main_queue(),^{UIPasteboard.generalPasteboard.string=fingerprint;resolve(nil);});
}
RCT_REMAP_METHOD(scanCamera, cameraLanguage:(NSString *)language resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
 dispatch_async(dispatch_get_main_queue(),^{
  if(self.resolve){reject(@"QR_CAMERA_UNAVAILABLE",@"Scanner busy",nil);return;}
  if(![AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo]){reject(@"QR_NO_CAMERA",@"Camera unavailable",nil);return;}
  self.resolve=resolve;self.reject=reject;self.generation++;NSUInteger operation=self.generation;
  void(^present)(BOOL)=^(BOOL granted){dispatch_async(dispatch_get_main_queue(),^{
   if(!self.resolve||operation!=self.generation)return;
   if(!granted){RCTPromiseRejectBlock failure=self.reject;self.resolve=nil;self.reject=nil;self.generation++;failure(@"QR_CAMERA_DENIED",@"Camera access denied",nil);return;}
   UIViewController *presenter=RCTPresentedViewController();if(!presenter){[self finish:nil error:YES];return;}
   PalMeshCameraController *camera=[PalMeshCameraController new];camera.arabic=[language isEqualToString:@"ar"];camera.modalPresentationStyle=UIModalPresentationFullScreen;
   camera.onResult=^(NSString *value,NSString *error){if(!self.resolve||operation!=self.generation)return;if(error){RCTPromiseRejectBlock failure=self.reject;self.resolve=nil;self.reject=nil;self.generation++;failure(error,@"Camera unavailable",nil);}else [self finish:value error:NO];};
   [presenter presentViewController:camera animated:YES completion:nil];
  });};
  AVAuthorizationStatus status=[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];if(status==AVAuthorizationStatusNotDetermined)[AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:present];else present(status==AVAuthorizationStatusAuthorized);
 });
}
- (void)picker:(PHPickerViewController *)picker didFinishPicking:(NSArray<PHPickerResult *> *)results {
  [picker dismissViewControllerAnimated:YES completion:nil];
  if (!self.resolve) return;
  if (results.count != 1) { [self finish:nil error:NO]; return; }
  NSUInteger operation=self.generation;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,15*NSEC_PER_SEC),dispatch_get_main_queue(),^{ if (self.resolve && self.generation==operation) [self finish:nil error:YES]; });
  self.progress=[results[0].itemProvider loadFileRepresentationForTypeIdentifier:@"public.image" completionHandler:^(NSURL *url,NSError *failure) {
    NSString *value=nil;
    NSNumber *size=nil;
    if (!failure && url.isFileURL && [url getResourceValue:&size forKey:NSURLFileSizeKey error:nil] && size.unsignedLongLongValue <= 8*1024*1024) {
      CGImageSourceRef source=CGImageSourceCreateWithURL((__bridge CFURLRef)url,NULL);
      if (source) {
        NSDictionary *options=@{(NSString *)kCGImageSourceCreateThumbnailFromImageAlways:@YES,
          (NSString *)kCGImageSourceThumbnailMaxPixelSize:@2048,
          (NSString *)kCGImageSourceCreateThumbnailWithTransform:@YES};
        CGImageRef thumbnail=CGImageSourceCreateThumbnailAtIndex(source,0,(__bridge CFDictionaryRef)options);
        if (thumbnail) {
          CIImage *input=[CIImage imageWithCGImage:thumbnail];
          CIDetector *detector=[CIDetector detectorOfType:CIDetectorTypeQRCode context:nil options:@{CIDetectorAccuracy:CIDetectorAccuracyHigh}];
          NSArray *features=[detector featuresInImage:input];
          if (features.count == 1 && [features[0] isKindOfClass:CIQRCodeFeature.class]) value=((CIQRCodeFeature *)features[0]).messageString;
          if ([value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 2048) value=nil;
          CGImageRelease(thumbnail);
        }
        CFRelease(source);
      }
    }
    dispatch_async(dispatch_get_main_queue(),^{ if (self.resolve && self.generation==operation) [self finish:value error:value==nil]; });
  }];
}
- (void)invalidate { dispatch_async(dispatch_get_main_queue(),^{ [self finish:nil error:YES]; }); }
@end
