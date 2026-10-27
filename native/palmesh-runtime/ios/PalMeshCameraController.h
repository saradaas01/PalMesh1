#import <UIKit/UIKit.h>
@interface PalMeshCameraController : UIViewController
@property(nonatomic,copy) void (^onResult)(NSString *value,NSString *error);
@property(nonatomic) BOOL arabic;
@end
