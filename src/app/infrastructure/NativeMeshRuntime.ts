export interface BatteryState {
  /** Fraction from zero to one; null when the OS cannot provide a reading. */
  readonly level: number | null;
  readonly charging: boolean;
  readonly lowPower: boolean;
}

export type NativeRuntimeEvent =
  | { readonly type: 'background'; readonly running: boolean; readonly reason: 'started' | 'stopped' | 'user-stopped' | 'unavailable' }
  | { readonly type: 'battery'; readonly battery: BatteryState };

export interface NativeMeshRuntimeModule {
  checkNotifications(): Promise<boolean>;
  getBatteryState(): Promise<BatteryState>;
  startMeshService(): Promise<void>;
  stopMeshService(): Promise<void>;
  showEmergencyNotification(id: string): Promise<void>;
  cancelEmergencyNotification(id: string): Promise<void>;
  /** Used by NativeEventEmitter, never to start background work. */
  addListener(event: string): void;
  removeListeners(count: number): void;
}

export interface RuntimeEventSource {
  addListener(event: string, listener: (event: unknown) => void): { remove(): void };
}

export interface NotificationPermissionPrompt {
  /** Called only by the explicit user action that enables alerts/background mesh. */
  request(): Promise<void>;
}

export interface NativeMeshRuntimeOptions {
  readonly platform: 'android' | 'ios' | 'unsupported';
  readonly bridge?: NativeMeshRuntimeModule;
  readonly events?: RuntimeEventSource;
  readonly notifications?: NotificationPermissionPrompt;
}

export class NativeRuntimeUnavailableError extends Error {
  constructor(readonly code: 'runtime-unavailable' | 'background-unsupported' | 'notifications-disabled') {
    super(code);
    this.name = 'NativeRuntimeUnavailableError';
  }
}

/** This adapter never requests OS permissions during startup, resume, battery
 * monitoring or SOS receipt. Android background mesh is an explicit, reversible
 * opt-in and remains best effort while the JavaScript process survives. */
export class NativeMeshRuntime {
  readonly supportsBackground: boolean;
  private readonly listeners = new Set<(event: NativeRuntimeEvent) => void>();
  private subscription: { remove(): void } | undefined;
  private operations: Promise<void> = Promise.resolve();
  private permissionRequest: Promise<boolean> | undefined;

  constructor(private readonly options: NativeMeshRuntimeOptions) {
    this.supportsBackground = options.platform === 'android' && options.bridge !== undefined;
  }

  async checkNotifications(): Promise<boolean> {
    if (!this.options.bridge) return false;
    const granted = await this.options.bridge.checkNotifications();
    if (typeof granted !== 'boolean') throw new TypeError('Invalid notification permission result');
    return granted;
  }

  requestNotifications(): Promise<boolean> {
    if (!this.options.bridge) return Promise.resolve(false);
    if (this.permissionRequest) return this.permissionRequest;
    const pending = (async () => {
      if (await this.checkNotifications()) return true;
      await this.options.notifications?.request();
      return this.checkNotifications();
    })();
    this.permissionRequest = pending;
    const clear = () => { if (this.permissionRequest === pending) this.permissionRequest = undefined; };
    void pending.then(clear, clear);
    return pending;
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.supportsBackground) throw new NativeRuntimeUnavailableError('background-unsupported');
      if (!await this.checkNotifications()) throw new NativeRuntimeUnavailableError('notifications-disabled');
      await this.bridge().startMeshService();
    });
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this.supportsBackground) await this.bridge().stopMeshService();
    });
  }

  async getBatteryState(): Promise<BatteryState> {
    return battery(await this.bridge().getBatteryState());
  }

  subscribe(listener: (event: NativeRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.subscription && this.options.events) {
      this.subscription = this.options.events.addListener('PalMeshRuntimeEvent', value => {
        const event = parseEvent(value);
        if (!event) return;
        for (const subscriber of [...this.listeners]) {
          try { subscriber(event); } catch { /* Observers cannot interrupt cleanup or another observer. */ }
        }
      });
    }
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.subscription?.remove();
        this.subscription = undefined;
      }
    };
  }

  /** The emergency feature's alert port intentionally receives no content at
   * the native boundary. Default lock-screen notifications stay generic. */
  async notifyIncoming(alert: { readonly id: string; readonly source?: string; readonly text?: string }): Promise<void> {
    assertAlertId(alert.id);
    await this.bridge().showEmergencyNotification(alert.id);
  }

  async cancel(id: string): Promise<void> {
    assertAlertId(id);
    await this.bridge().cancelEmergencyNotification(id);
  }

  private bridge(): NativeMeshRuntimeModule {
    if (!this.options.bridge) throw new NativeRuntimeUnavailableError('runtime-unavailable');
    return this.options.bridge;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.operations.then(operation);
    this.operations = pending.catch(() => {});
    return pending;
  }
}

function battery(value: unknown): BatteryState {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid native battery state');
  const reading = value as Record<string, unknown>;
  if (!(reading.level === null || typeof reading.level === 'number' && Number.isFinite(reading.level)
    && reading.level >= 0 && reading.level <= 1)
    || typeof reading.charging !== 'boolean' || typeof reading.lowPower !== 'boolean') {
    throw new TypeError('Invalid native battery state');
  }
  return Object.freeze({ level: reading.level as number | null, charging: reading.charging, lowPower: reading.lowPower });
}

function parseEvent(value: unknown): NativeRuntimeEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  if (event.type === 'battery') {
    try { return Object.freeze({ type: 'battery', battery: battery(event.battery) }); }
    catch { return null; }
  }
  if (event.type === 'background' && typeof event.running === 'boolean'
    && ['started', 'stopped', 'user-stopped', 'unavailable'].includes(String(event.reason))) {
    if (event.running !== (event.reason === 'started')) return null;
    return Object.freeze({ type: 'background', running: event.running,
      reason: event.reason as Extract<NativeRuntimeEvent, { type: 'background' }>['reason'] });
  }
  return null;
}

function assertAlertId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError('Invalid emergency alert identifier');
}
