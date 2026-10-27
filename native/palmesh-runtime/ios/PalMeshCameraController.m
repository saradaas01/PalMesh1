#import "PalMeshCameraController.h"
#import <AVFoundation/AVFoundation.h>
@interface PalMeshCameraController () <AVCaptureMetadataOutputObjectsDelegate>
@property(nonatomic,strong) AVCaptureSession *session;
@property(nonatomic,strong) AVCaptureVideoPreviewLayer *preview;
@property(nonatomic,strong) UIView *frame;
@property(nonatomic,strong) dispatch_queue_t cameraQueue;
@property(nonatomic) BOOL finished;
@end
@implementation PalMeshCameraController
- (void)viewDidLoad {
 [super viewDidLoad];[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(cancel) name:UIApplicationDidEnterBackgroundNotification object:nil];self.view.backgroundColor=UIColor.blackColor;self.cameraQueue=dispatch_queue_create("org.palmesh.public-qr-camera",DISPATCH_QUEUE_SERIAL);
 self.session=[AVCaptureSession new];AVCaptureDevice *device=[AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
 if(!device){[self end:nil error:@"QR_NO_CAMERA"];return;}
 NSError *error=nil;AVCaptureDeviceInput *input=[AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
 AVCaptureMetadataOutput *output=[AVCaptureMetadataOutput new];
 if(error||!input||![self.session canAddInput:input]){[self end:nil error:@"QR_CAMERA_UNAVAILABLE"];return;}
 [self.session addInput:input];if(![self.session canAddOutput:output]){[self end:nil error:@"QR_CAMERA_UNAVAILABLE"];return;}[self.session addOutput:output];
 if(![output.availableMetadataObjectTypes containsObject:AVMetadataObjectTypeQRCode]){[self end:nil error:@"QR_CAMERA_UNAVAILABLE"];return;}
 output.metadataObjectTypes=@[AVMetadataObjectTypeQRCode];[output setMetadataObjectsDelegate:self queue:dispatch_get_main_queue()];
 self.preview=[AVCaptureVideoPreviewLayer layerWithSession:self.session];self.preview.videoGravity=AVLayerVideoGravityResizeAspectFill;[self.view.layer addSublayer:self.preview];
 self.frame=[UIView new];self.frame.layer.borderWidth=3;self.frame.layer.borderColor=UIColor.whiteColor.CGColor;self.frame.layer.cornerRadius=20;self.frame.userInteractionEnabled=NO;[self.view addSubview:self.frame];
 UILabel *hint=[UILabel new];hint.text=self.arabic?@"ضع رمز PalMesh داخل الإطار":@"Place a PalMesh QR code inside the frame";hint.textColor=UIColor.whiteColor;hint.numberOfLines=0;hint.textAlignment=NSTextAlignmentCenter;hint.font=[UIFont preferredFontForTextStyle:UIFontTextStyleHeadline];hint.adjustsFontForContentSizeCategory=YES;hint.translatesAutoresizingMaskIntoConstraints=NO;[self.view addSubview:hint];
 UIButton *cancel=[UIButton buttonWithType:UIButtonTypeSystem];[cancel setTitle:self.arabic?@"إلغاء":@"Cancel" forState:UIControlStateNormal];cancel.titleLabel.font=[UIFont preferredFontForTextStyle:UIFontTextStyleHeadline];cancel.titleLabel.adjustsFontForContentSizeCategory=YES;[cancel setTitleColor:UIColor.whiteColor forState:UIControlStateNormal];cancel.translatesAutoresizingMaskIntoConstraints=NO;[cancel addTarget:self action:@selector(cancel) forControlEvents:UIControlEventTouchUpInside];[self.view addSubview:cancel];
 [NSLayoutConstraint activateConstraints:@[[cancel.bottomAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.bottomAnchor constant:-16],[cancel.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],[cancel.heightAnchor constraintGreaterThanOrEqualToConstant:52],[hint.bottomAnchor constraintEqualToAnchor:cancel.topAnchor constant:-16],[hint.leadingAnchor constraintEqualToAnchor:self.view.leadingAnchor constant:24],[hint.trailingAnchor constraintEqualToAnchor:self.view.trailingAnchor constant:-24]]];
 AVCaptureSession *session=self.session;dispatch_async(self.cameraQueue,^{[session startRunning];});
}
- (void)viewDidLayoutSubviews {[super viewDidLayoutSubviews];self.preview.frame=self.view.bounds;CGFloat size=MIN(self.view.bounds.size.width,self.view.bounds.size.height)*.72;self.frame.frame=CGRectMake((self.view.bounds.size.width-size)/2,(self.view.bounds.size.height-size)/2,size,size);}
- (void)viewDidDisappear:(BOOL)animated {[super viewDidDisappear:animated];AVCaptureSession *session=self.session;if(self.cameraQueue)dispatch_async(self.cameraQueue,^{[session stopRunning];});if(!self.finished)[self end:nil error:nil];}
- (void)dealloc {[[NSNotificationCenter defaultCenter] removeObserver:self];}
- (void)cancel {[self end:nil error:nil];}
- (void)end:(NSString *)value error:(NSString *)error {if(self.finished)return;self.finished=YES;AVCaptureSession *session=self.session;if(self.cameraQueue)dispatch_async(self.cameraQueue,^{[session stopRunning];});void(^callback)(NSString *,NSString *)=self.onResult;self.onResult=nil;[self dismissViewControllerAnimated:YES completion:^{if(callback)callback(value,error);}];}
- (void)captureOutput:(AVCaptureOutput *)output didOutputMetadataObjects:(NSArray<__kindof AVMetadataObject *> *)objects fromConnection:(AVCaptureConnection *)connection {if(objects.count!=1)return;AVMetadataMachineReadableCodeObject *qr=(AVMetadataMachineReadableCodeObject *)objects.firstObject;NSString *value=qr.stringValue;if(value&&[value lengthOfBytesUsingEncoding:NSUTF8StringEncoding]<=2048)[self end:value error:nil];}
@end
