import type { PowerMode } from '../../features/dtn';
import type { LocationActionResult } from '../../features/maps';
import type { AppRoute, AppSnapshot, RadioPermissions, RuntimeResources } from '../domain/types';
import type { NativeMeshRuntime, NativeRuntimeEvent, BatteryState } from '../infrastructure/NativeMeshRuntime';

export interface AppRuntimeOptions {
  readonly createResources: () => Promise<RuntimeResources>;
  readonly permissions: RadioPermissions;
  readonly initiallyForeground?: boolean;
  readonly platformRuntime?: Pick<NativeMeshRuntime, 'supportsBackground' | 'start' | 'stop' | 'requestNotifications' | 'checkNotifications' | 'getBatteryState' | 'subscribe'>;
}

/** Owns one mesh node and its persistent feature services. Navigation changes
 * visibility, never storage ownership. Discovery is foreground-only; background
 * delivery is not promised by JavaScript timers or an unconfigured OS service. */
export class AppRuntime {
  private state: AppSnapshot;
  private readonly listeners = new Set<() => void>();
  private resources: RuntimeResources | null = null;
  private active = false;
  private generation = 0;
  private intent = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private radioWork: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private radioIntent = 0;
  private permissionRevision = 0;
  private alertsRevision = 0;
  private unsubscribePlatform: (() => void) | null = null;
  private backgroundIntent = 0;
  private backgroundWork: Promise<void> = Promise.resolve();
  private manualPowerMode: PowerMode = 'normal';
  private readonly cleanups = new WeakMap<RuntimeResources, Promise<void>>();

  constructor(private readonly options: AppRuntimeOptions) {
    this.state = Object.freeze({
      status: 'idle', route: 'chat', foreground: options.initiallyForeground ?? true,
      resources: null, permissions: null, radios: Object.freeze({}), connectedPeers: 0,
      requestingPermissions: false, pendingSos: false, powerMode: 'normal', issue: null, notice: null,
      backgroundEnabled: false, backgroundBusy: false, backgroundSupported: options.platformRuntime?.supportsBackground ?? false,
      battery: null, automaticPowerMode: true,
      alertsEnabled: null, alertsBusy: false,
    });
  }

  getSnapshot = (): AppSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start(): Promise<void> {
    const intent = ++this.intent;
    return this.transition(async () => {
      if (intent !== this.intent || this.active) return;
      this.active = true;
      const generation = ++this.generation;
      this.attachPlatform(generation);
      let resources: RuntimeResources | null = null;
      this.patch({ status: 'starting', issue: null, notice: null, pendingSos: false, requestingPermissions: false,
        permissions: null, resources: null, radios: Object.freeze({}), connectedPeers: 0 });
      void this.checkPermissions(generation);
      try {
        resources = await this.options.createResources();
        if (!this.live(generation)) { await this.cleanup(resources); return; }
        this.resources = resources;
        resources.chat.setVisible(false);
        resources.locations.setVisible(false);
        resources.node.engine.setPowerMode(this.state.powerMode);
        resources.locations.setPowerMode(this.state.powerMode);
        this.unsubscribe = resources.node.mesh.subscribe(event => {
          if (!this.live(generation)) return;
          if (event.type === 'peers') this.patch({ connectedPeers: this.radiosAllowed() ? event.peers.length : 0 });
          else if (event.type === 'radio-status') this.patch({ radios: Object.freeze({ ...this.state.radios, [event.radio]: Object.freeze({ ...event.status }) }) });
          else if (event.type === 'error') this.patch({ issue: 'radio-error' });
        });
        // createMeshNode.start() starts discovery too. Starting its engine
        // independently avoids ever starting radios in an initial background launch.
        await resources.node.engine.start();
        if (!this.live(generation)) return;
        const features = await Promise.allSettled([resources.chat.start(), resources.locations.start(), resources.emergency?.start()]);
        const failure = features.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        if (!this.live(generation)) return;
        this.patch({ status: 'ready', resources, connectedPeers: resources.node.mesh.connectedPeers().length });
        this.applyVisibility();
        if (this.state.foreground) void this.resumeRadios(generation, resources);
      } catch {
        if (this.live(generation)) {
          this.active = false;
          this.detach();
          this.unsubscribePlatform?.(); this.unsubscribePlatform = null;
          this.patch({ status: 'error', resources: null, issue: 'startup-failed' });
        }
      } finally {
        if (resources && !this.live(generation)) {
          if (this.resources === resources) this.resources = null;
          try { await this.cleanup(resources); } catch { /* Startup/stop already reports failure. */ }
        }
      }
    });
  }

  stop(): Promise<void> {
    this.intent += 1;
    this.active = false;
    this.generation += 1;
    this.backgroundIntent += 1;
    this.unsubscribePlatform?.(); this.unsubscribePlatform = null;
    const stoppingBackground = this.options.platformRuntime?.stop().catch(() => {}) ?? Promise.resolve();
    const resources = this.resources;
    if (resources) { resources.chat.setVisible(false); resources.locations.setVisible(false); }
    this.detach();
    // stop() cancels in-flight discovery immediately, rather than waiting for
    // an outstanding native start before beginning cancellation.
    if (resources) this.pauseRadios(resources);
    this.patch({ status: 'idle', foreground: false, resources: null, requestingPermissions: false, pendingSos: false, connectedPeers: 0,
      backgroundEnabled: false, backgroundBusy: false, alertsBusy: false });
    return this.transition(async () => {
      // An OS permission dialog cannot be cancelled. Its stale completion is
      // generation guarded; it must not delay closing routing/storage handles.
      await stoppingBackground;
      if (resources) {
        try { await this.cleanup(resources); }
        catch { this.patch({ issue: 'radio-error' }); }
      }
      if (this.resources === resources) this.resources = null;
    });
  }

  navigate = (route: AppRoute): void => {
    if (!['chat', 'maps', 'emergencies', 'contacts'].includes(route)) throw new TypeError('Invalid app route');
    this.patch({ route });
    this.applyVisibility();
  };

  setForeground = (foreground: boolean): void => {
    if (typeof foreground !== 'boolean') throw new TypeError('Invalid app visibility');
    if (foreground === this.state.foreground) return;
    this.patch({ foreground });
    this.applyVisibility();
    const resources = this.resources;
    if (!resources || !this.active) return;
    if (!foreground && !this.state.backgroundEnabled) this.pauseRadios(resources);
    else if (this.state.status === 'ready') {
      const generation = this.generation;
      void this.checkPermissions(generation);
      void this.checkAlertPermission(generation);
      void this.resumeRadios(generation, resources);
      // Reconcile reports/custody collected while native background execution
      // suspended JavaScript, while preserving route-specific unread semantics.
      void resources.chat.refresh();
      void resources.locations.refresh();
    }
  };

  requestPermissions = async (): Promise<void> => {
    if (!this.active || !this.state.foreground || this.state.requestingPermissions) return;
    const generation = this.generation;
    const revision = ++this.permissionRevision;
    this.patch({ requestingPermissions: true, issue: null });
    try {
      const permissions = await this.options.permissions.request();
      if (!this.live(generation) || revision !== this.permissionRevision) return;
      this.patch({ permissions: Object.freeze({ ...permissions }) });
      const resources = this.resources;
      if (resources && this.state.status === 'ready' && this.state.foreground) await this.resumeRadios(generation, resources);
    } catch {
      if (this.live(generation)) this.patch({ issue: 'permissions-unavailable' });
    } finally {
      if (this.live(generation)) this.patch({ requestingPermissions: false });
    }
  };

  sendSos = async (text?: string): Promise<LocationActionResult> => {
    const resources = this.resources;
    if (!this.active || this.state.status !== 'ready' || !resources) {
      this.patch({ issue: 'sos-unavailable', notice: null });
      return { status: 'rejected', reason: 'unavailable' };
    }
    if (this.state.pendingSos) return { status: 'rejected', reason: 'busy' };
    const generation = this.generation;
    this.patch({ pendingSos: true, issue: null, notice: null });
    try {
      // One use case from every route: locations attaches the timestamped
      // cached fix, then publishes immediately through the durable DTN queue.
      const result = await resources.locations.sendSos(text);
      if (this.live(generation)) {
        if (result.status === 'queued') this.patch({ notice: 'sos-queued' });
        else this.patch({ issue: result.status === 'rejected' && result.reason === 'capacity' ? 'queue-full' : 'sos-unavailable' });
      }
      return result;
    } catch {
      if (this.live(generation)) this.patch({ issue: 'sos-unavailable' });
      return { status: 'rejected', reason: 'unavailable' };
    } finally {
      if (this.live(generation)) this.patch({ pendingSos: false });
    }
  };

  setPowerMode = (powerMode: PowerMode): void => {
    if (powerMode !== 'normal' && powerMode !== 'conserve') throw new TypeError('Invalid app power mode');
    this.manualPowerMode = powerMode;
    this.patch({ automaticPowerMode: false });
    this.applyPowerMode(powerMode);
  };
  setAutomaticPowerMode = (automatic: boolean): void => {
    if (typeof automatic !== 'boolean') throw new TypeError('Invalid automatic battery mode');
    this.patch({ automaticPowerMode: automatic });
    this.applyPowerMode(automatic ? this.batteryPowerMode(this.state.battery) : this.manualPowerMode);
  };

  requestAlerts = async (): Promise<void> => {
    const platform = this.options.platformRuntime;
    if (!this.active || !this.state.foreground || this.state.alertsBusy || !platform) return;
    const generation = this.generation;
    const revision = ++this.alertsRevision;
    this.patch({ alertsBusy: true, issue: null });
    try {
      const enabled = await platform.requestNotifications();
      if (this.live(generation) && revision === this.alertsRevision) this.patch({ alertsEnabled: enabled,
        ...(enabled ? {} : { issue: 'alerts-unavailable' as const }) });
    } catch { if (this.live(generation)) this.patch({ issue: 'alerts-unavailable' }); }
    finally { if (this.live(generation)) this.patch({ alertsBusy: false }); }
  };

  setBackgroundEnabled = (enabled: boolean): Promise<void> => {
    if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('Invalid background intent'));
    const intent = ++this.backgroundIntent;
    const generation = this.generation;
    const operation = this.backgroundWork.then(async () => {
      if (intent !== this.backgroundIntent) return;
      const platform = this.options.platformRuntime;
      if (!enabled) {
        this.patch({ backgroundEnabled: false, backgroundBusy: true });
        try { await platform?.stop(); }
        catch { if (this.live(generation)) this.patch({ issue: 'background-unavailable' }); }
        finally {
          if (this.live(generation)) {
            this.patch({ backgroundBusy: false });
            if (!this.state.foreground && this.resources) this.pauseRadios(this.resources);
            else if (this.resources) await this.resumeRadios(generation, this.resources);
          }
        }
        return;
      }
      if (!this.live(generation) || !this.state.foreground || this.state.status !== 'ready'
        || !platform?.supportsBackground) {
        if (this.live(generation)) this.patch({ issue: 'background-unavailable' });
        return;
      }
      this.patch({ backgroundBusy: true, issue: null });
      try {
        const revision = ++this.alertsRevision;
        if (!await platform.requestNotifications()) throw new Error('Notifications disabled');
        if (this.live(generation) && revision === this.alertsRevision) this.patch({ alertsEnabled: true });
        if (!this.live(generation) || intent !== this.backgroundIntent || !this.state.foreground) return;
        await platform.start();
        if (!this.live(generation) || intent !== this.backgroundIntent) { await platform.stop(); return; }
        this.patch({ backgroundEnabled: true });
        if (this.resources) await this.resumeRadios(generation, this.resources);
      } catch {
        if (this.live(generation)) this.patch({ backgroundEnabled: false, issue: 'background-unavailable' });
      } finally { if (this.live(generation) && intent === this.backgroundIntent) this.patch({ backgroundBusy: false }); }
    });
    this.backgroundWork = operation.catch(() => {});
    return operation;
  };
  dismissIssue = (): void => { this.patch({ issue: null }); };
  dismissNotice = (): void => { this.patch({ notice: null }); };

  private applyVisibility(): void {
    if (!this.resources) return;
    const visible = this.state.status === 'ready' && this.state.foreground;
    this.resources.chat.setVisible(visible && this.state.route === 'chat');
    this.resources.locations.setVisible(visible && this.state.route === 'maps');
  }

  private async checkPermissions(generation: number): Promise<void> {
    if (this.state.requestingPermissions) return;
    const revision = ++this.permissionRevision;
    try {
      const permissions = await this.options.permissions.check();
      if (this.live(generation) && revision === this.permissionRevision) this.patch({ permissions: Object.freeze({ ...permissions }) });
    } catch { if (this.live(generation) && revision === this.permissionRevision) this.patch({ issue: 'permissions-unavailable' }); }
  }

  private resumeRadios(generation: number, resources: RuntimeResources): Promise<void> {
    const intent = ++this.radioIntent;
    return this.queueRadios(async () => {
      if (!this.live(generation) || !this.radiosAllowed() || intent !== this.radioIntent) return;
      await resources.node.mesh.start();
      if (!this.live(generation) || !this.radiosAllowed() || intent !== this.radioIntent) return;
      await resources.node.mesh.refreshRadios();
      if (this.live(generation) && this.radiosAllowed() && intent === this.radioIntent) {
        this.patch({ connectedPeers: resources.node.mesh.connectedPeers().length });
      }
    }, generation);
  }

  private pauseRadios(resources: RuntimeResources): void {
    this.radioIntent += 1;
    let stopping: Promise<void>;
    try { stopping = resources.node.mesh.stop(); }
    catch { stopping = Promise.reject(new Error('Could not stop mesh')); }
    // Observe the eager stop immediately; queue ownership still ensures a new
    // foreground start waits for that stop to finish.
    const observed = stopping.catch(() => { if (this.active) this.patch({ issue: 'radio-error' }); });
    void this.queueRadios(() => observed, this.generation);
    this.patch({ connectedPeers: 0 });
  }

  private queueRadios(operation: () => Promise<void>, generation: number): Promise<void> {
    const next = this.radioWork.then(operation);
    this.radioWork = next.catch(() => { if (this.live(generation)) this.patch({ issue: 'radio-error' }); });
    return this.radioWork;
  }

  private cleanup(resources: RuntimeResources): Promise<void> {
    const existing = this.cleanups.get(resources);
    if (existing) return existing;
    const cleanup = (async () => {
      await this.radioWork;
      // Wait for both services, including a failed sibling, before closing any
      // native resources they may still use. Always attempt the remaining cleanup.
      const features = await Promise.allSettled([
        Promise.resolve().then(() => resources.chat.stop()),
        Promise.resolve().then(() => resources.locations.stop()),
        Promise.resolve().then(() => resources.emergency?.stop()),
      ]);
      const node = await Promise.allSettled([Promise.resolve().then(() => resources.node.stop())]);
      const released = await Promise.allSettled([Promise.resolve().then(() => resources.release())]);
      const failed = [...features, ...node, ...released].find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    this.cleanups.set(resources, cleanup);
    return cleanup;
  }

  private detach(): void { try { this.unsubscribe?.(); } catch { /* Generation guards still reject old events. */ } this.unsubscribe = null; }
  private radiosAllowed(): boolean { return this.state.foreground || this.state.backgroundEnabled; }
  private attachPlatform(generation: number): void {
    this.unsubscribePlatform?.();
    const platform = this.options.platformRuntime;
    if (!platform) return;
    this.unsubscribePlatform = platform.subscribe(event => {
      if (!this.live(generation)) return;
      this.onPlatformEvent(event);
    });
    void platform.getBatteryState().then(battery => {
      if (this.live(generation)) this.onPlatformEvent({ type: 'battery', battery });
    }).catch(() => { /* Unknown battery readings never disable SOS. */ });
    void this.checkAlertPermission(generation);
  }
  private async checkAlertPermission(generation: number): Promise<void> {
    const platform = this.options.platformRuntime;
    if (!platform || this.state.alertsBusy) return;
    const revision = this.alertsRevision;
    try {
      const alertsEnabled = await platform.checkNotifications();
      if (this.live(generation) && revision === this.alertsRevision) this.patch({ alertsEnabled });
    } catch { /* A failed read-only check is not a permission request. */ }
  }
  private onPlatformEvent(event: NativeRuntimeEvent): void {
    if (event.type === 'battery') {
      this.patch({ battery: event.battery });
      if (this.state.automaticPowerMode) this.applyPowerMode(this.batteryPowerMode(event.battery));
    } else if (!event.running) {
      this.patch({ backgroundEnabled: false });
      if (!this.state.foreground && this.resources) this.pauseRadios(this.resources);
      // Stopping the native session also tears down owned radio controllers.
      else if (event.reason === 'user-stopped' && this.resources) void this.resumeRadios(this.generation, this.resources);
    }
  }
  private batteryPowerMode(battery: BatteryState | null): PowerMode {
    return battery?.lowPower || battery?.level !== null && battery?.level !== undefined && battery.level <= 0.2 && !battery.charging
      ? 'conserve' : 'normal';
  }
  private applyPowerMode(powerMode: PowerMode): void {
    this.patch({ powerMode });
    this.resources?.node.engine.setPowerMode(powerMode);
    this.resources?.locations.setPowerMode(powerMode);
  }
  private live(generation: number): boolean { return this.active && this.generation === generation; }
  private transition(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(operation);
    this.lifecycle = next.catch(() => {});
    return next;
  }
  private patch(patch: Partial<AppSnapshot>): void {
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* UI cannot interrupt runtime cleanup. */ } }
  }
}
