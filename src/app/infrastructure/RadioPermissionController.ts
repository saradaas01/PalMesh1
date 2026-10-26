import type { RadioPermissionReport, RadioPermissions } from '../domain/types';

export type NativeRadioPermissionResult = 'granted' | 'denied' | 'never_ask_again';
export interface NativeRadioPermissionBridge {
  check(permission: string): Promise<boolean>;
  requestMultiple(permissions: readonly string[]): Promise<Readonly<Record<string, NativeRadioPermissionResult>>>;
}

export type IosBluetoothAuthorization = 'granted' | 'not-determined' | 'denied' | 'restricted';
/** A future iOS host must supply an authorization bridge that checks without
 * constructing a Bluetooth manager or opening the system permission prompt. */
export interface IosBluetoothAuthorizationBridge {
  check(): Promise<IosBluetoothAuthorization>;
  request(): Promise<IosBluetoothAuthorization>;
}

export interface RadioPermissionControllerOptions {
  readonly platform: RadioPermissionReport['platform'];
  readonly apiLevel?: number;
  readonly bridge?: NativeRadioPermissionBridge;
  readonly iosBluetoothAuthorization?: IosBluetoothAuthorizationBridge;
}

export const RADIO_PERMISSIONS = Object.freeze({
  fineLocation: 'android.permission.ACCESS_FINE_LOCATION',
  coarseLocation: 'android.permission.ACCESS_COARSE_LOCATION',
  nearbyWifi: 'android.permission.NEARBY_WIFI_DEVICES',
  bluetoothScan: 'android.permission.BLUETOOTH_SCAN',
  bluetoothConnect: 'android.permission.BLUETOOTH_CONNECT',
  bluetoothAdvertise: 'android.permission.BLUETOOTH_ADVERTISE',
});

/** Permission state belongs to each radio independently: denying Wi-Fi must
 * not disable an otherwise authorized BLE transport. GPS fixes use a separate
 * permission action; location appears here only for legacy Android discovery. */
export class RadioPermissionController implements RadioPermissions {
  private readonly platform: RadioPermissionReport['platform'];
  private readonly bridge: NativeRadioPermissionBridge | undefined;
  private readonly ios: IosBluetoothAuthorizationBridge | undefined;
  private readonly wifi: readonly string[];
  private readonly bluetooth: readonly string[];
  private readonly required: readonly string[];
  private readonly coarseLocationCompanion: boolean;
  // PermissionsAndroid.check exposes only a boolean. Permanent denial is known
  // after this process receives a request result; a later process must inspect
  // its own request result before it can distinguish denial from "never ask".
  private readonly permanentlyDenied = new Set<string>();
  private operations: Promise<void> = Promise.resolve();
  private pendingRequest: Promise<RadioPermissionReport> | undefined;

  constructor(options: RadioPermissionControllerOptions) {
    this.platform = options.platform;
    this.bridge = options.bridge;
    this.ios = options.iosBluetoothAuthorization;
    if (!['android', 'ios', 'unsupported'].includes(options.platform)) {
      throw new TypeError('Unsupported permission platform');
    }
    if (options.platform === 'android') {
      if (!Number.isSafeInteger(options.apiLevel) || options.apiLevel! < 1) {
        throw new TypeError('Android permissions require a known positive integer API level');
      }
      if (!this.bridge) throw new TypeError('Android permissions require a native permission bridge');
      const sdk = options.apiLevel!;
      this.coarseLocationCompanion = sdk === 31 || sdk === 32;
      // Prior to API 23 these are manifest/install permissions, not runtime prompts.
      this.wifi = sdk < 23 ? [] : [sdk >= 33 ? RADIO_PERMISSIONS.nearbyWifi : RADIO_PERMISSIONS.fineLocation];
      this.bluetooth = sdk < 23 ? [] : sdk >= 31
        ? [RADIO_PERMISSIONS.bluetoothScan, RADIO_PERMISSIONS.bluetoothConnect, RADIO_PERMISSIONS.bluetoothAdvertise]
        : [RADIO_PERMISSIONS.fineLocation];
    } else {
      this.coarseLocationCompanion = false;
      this.wifi = [];
      this.bluetooth = [];
    }
    this.required = [...new Set([...this.wifi, ...this.bluetooth])];
  }

  check(): Promise<RadioPermissionReport> {
    return this.enqueue(() => this.read(false));
  }

  request(): Promise<RadioPermissionReport> {
    // One user action may race with a second tap or a screen transition. Both
    // callers share the same prompt and result, including native failures.
    if (this.pendingRequest) return this.pendingRequest;
    const pending = this.enqueue(() => this.read(true));
    this.pendingRequest = pending;
    const clear = () => { if (this.pendingRequest === pending) this.pendingRequest = undefined; };
    void pending.then(clear, clear);
    return pending;
  }

  private enqueue(action: () => Promise<RadioPermissionReport>): Promise<RadioPermissionReport> {
    const operation = this.operations.then(action);
    this.operations = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async read(request: boolean): Promise<RadioPermissionReport> {
    if (this.platform === 'android') return this.android(request);
    if (this.platform !== 'ios' || !this.ios) return this.report(false, false, false);
    let authorization = await this.ios.check();
    this.assertIosAuthorization(authorization);
    if (request && authorization === 'not-determined') {
      authorization = await this.ios.request();
      this.assertIosAuthorization(authorization);
    }
    return this.report(false, authorization === 'granted', authorization === 'not-determined');
  }

  private async android(request: boolean): Promise<RadioPermissionReport> {
    const bridge = this.bridge!;
    const checks = await Promise.all(this.required.map(async permission => {
      const granted = await bridge.check(permission);
      if (typeof granted !== 'boolean') throw new TypeError('Invalid native permission check result');
      return [permission, granted] as const;
    }));
    const grants = new Map(checks);
    for (const [permission, granted] of checks) {
      if (granted) this.permanentlyDenied.delete(permission); // Settings can restore access.
    }
    const missing = this.required.filter(permission => !grants.get(permission) && !this.permanentlyDenied.has(permission));
    if (request && missing.length > 0) {
      // Android 12 can ignore a fine-location-only request. Coarse access is a
      // prompt companion, not a replacement for the precise access Wi-Fi Direct
      // requires and not an additional prerequisite for Bluetooth authorization.
      const requested = missing.flatMap(permission => this.coarseLocationCompanion && permission === RADIO_PERMISSIONS.fineLocation
        ? [permission, RADIO_PERMISSIONS.coarseLocation] : [permission]);
      const result = await bridge.requestMultiple(requested);
      // Validate the whole result before changing cached state, so malformed
      // native output cannot leave a partially authorized report behind.
      for (const permission of requested) {
        if (!['granted', 'denied', 'never_ask_again'].includes(result[permission] ?? '')) {
          throw new TypeError('Invalid native permission request result');
        }
      }
      for (const permission of missing) {
        const status = result[permission]!;
        grants.set(permission, status === 'granted');
        if (status === 'never_ask_again') this.permanentlyDenied.add(permission);
      }
    }
    const granted = (permissions: readonly string[]) => permissions.every(permission => grants.get(permission) === true);
    return this.report(granted(this.wifi), granted(this.bluetooth),
      this.required.some(permission => !grants.get(permission) && !this.permanentlyDenied.has(permission)));
  }

  private report(wifiDirect: boolean, bluetooth: boolean, canRequest: boolean): RadioPermissionReport {
    return Object.freeze({ platform: this.platform, wifiDirect, bluetooth, canRequest });
  }

  private assertIosAuthorization(value: IosBluetoothAuthorization): void {
    if (!['granted', 'not-determined', 'denied', 'restricted'].includes(value)) {
      throw new TypeError('Invalid iOS Bluetooth authorization result');
    }
  }
}
