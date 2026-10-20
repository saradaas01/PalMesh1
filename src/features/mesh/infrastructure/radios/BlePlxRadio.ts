import type { RadioAdapter } from '../../domain/ports';
import { PALMESH_BLE_NOTIFY, PALMESH_BLE_SERVICE, PALMESH_BLE_WRITE } from '../../domain/types';
import type { RadioEvent, RadioLink, RadioStatus } from '../../domain/types';
import { base64ToBytes, bytesToBase64 } from '../../domain/wire';
import { abortError, ignoreFailure, isRadioId, isRadioLink, OrderedRadioWrites, RadioEvents, RadioOperations } from './shared';

export interface BlePlxSubscription { remove(): void }
export interface BlePlxDevice { readonly id: string; readonly mtu: number; readonly rssi: number | null }
export interface BlePlxCharacteristic { readonly value: string | null }

/** Compatible structural subset of react-native-ble-plx 3.5.1. The mobile host
 * owns BleManager, permissions and destroy(); the adapter only owns its scan,
 * device links, subscriptions and native transaction IDs. */
export interface BlePlxManager {
  state(): Promise<string>;
  onStateChange(listener: (state: string) => void, emitCurrentState?: boolean): BlePlxSubscription;
  startDeviceScan(services: string[] | null, options: { allowDuplicates?: boolean } | null,
    listener: (error: unknown | null, device: BlePlxDevice | null) => void): Promise<void>;
  stopDeviceScan(): Promise<void>;
  connectToDevice(id: string, options?: { requestMTU?: number; timeout?: number }): Promise<BlePlxDevice>;
  cancelDeviceConnection(id: string): Promise<unknown>;
  discoverAllServicesAndCharacteristicsForDevice(id: string, transactionId?: string): Promise<BlePlxDevice>;
  monitorCharacteristicForDevice(id: string, service: string, characteristic: string,
    listener: (error: unknown | null, characteristic: BlePlxCharacteristic | null) => void,
    transactionId?: string): BlePlxSubscription;
  onDeviceDisconnected(id: string, listener: (error: unknown | null, device: BlePlxDevice | null) => void): BlePlxSubscription;
  writeCharacteristicWithResponseForDevice(id: string, service: string, characteristic: string,
    value: string, transactionId?: string): Promise<unknown>;
  cancelTransaction(id: string): Promise<void>;
}

export interface BlePlxRadioOptions {
  /** Must inspect already-granted OS permissions; requesting permissions belongs
   * in the host UI and must never be triggered from background discovery. */
  readonly permissionsGranted: () => Promise<boolean>;
  /** Native GATT server + advertiser (Android) / CBPeripheralManager (iOS).
   * BLE PLX is central-only and cannot host another phone's connection. */
  readonly peripheral?: RadioAdapter;
  readonly operationTimeoutMs?: number;
  readonly maxConnections?: number;
}

interface CentralLink {
  readonly link: RadioLink;
  readonly monitorId: string;
  readonly subscriptions: BlePlxSubscription[];
  released: boolean;
  published: boolean;
  readonly earlyData: Uint8Array[];
  earlyBytes: number;
}

let nextInstance = 0;

export class BlePlxRadio implements RadioAdapter {
  readonly kind = 'ble' as const;
  readonly capabilities: { readonly central: true; readonly peripheral: boolean; readonly fullPhoneToPhone: boolean };
  private readonly instance = ++nextInstance;
  private readonly events = new RadioEvents();
  private readonly operations: RadioOperations;
  private readonly maxConnections: number;
  private readonly writes = new OrderedRadioWrites();
  private readonly central = new Map<string, CentralLink>();
  private readonly pendingEndpoints = new Set<string>();
  private readonly hosted = new Map<string, { readonly nativeId: string; readonly link: RadioLink }>();
  private readonly hostedByNative = new Map<string, string>();
  private readonly subscriptions: (() => void)[] = [];
  private generation = 0;
  private sequence = 0;
  private running = false;
  private stopping: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private stopFailed = false;

  constructor(private readonly manager: BlePlxManager | undefined, private readonly options: BlePlxRadioOptions) {
    if (options.peripheral && options.peripheral.kind !== 'ble') throw new Error('BLE peripheral adapter must use BLE radio kind');
    this.operations = new RadioOperations(`ble-${this.instance}`, options.operationTimeoutMs ?? 15_000);
    this.maxConnections = options.maxConnections ?? 8;
    if (!Number.isInteger(this.maxConnections) || this.maxConnections < 1 || this.maxConnections > 64) throw new Error('Invalid BLE connection limit');
    this.capabilities = Object.freeze({ central: true, peripheral: options.peripheral !== undefined, fullPhoneToPhone: options.peripheral !== undefined });
  }

  getStatus(): Promise<RadioStatus> { return this.status(); }

  private async status(signal?: AbortSignal): Promise<RadioStatus> {
    if (!this.manager) return { available: false, reason: 'unsupported' };
    const granted = await this.operations.run(signal, () => this.options.permissionsGranted(), () => undefined);
    if (!granted) return { available: false, reason: 'permission-denied' };
    const state = await this.operations.run(signal, () => this.manager!.state(), () => undefined);
    return this.statusForState(state);
  }

  subscribe(listener: (event: RadioEvent) => void): () => void { return this.events.subscribe(listener); }

  start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.stopping) return this.stopping.then(() => this.start(signal));
    if (this.starting) {
      const pending = this.starting;
      // A concurrent caller joins readiness without taking ownership of the
      // first caller's discovery lifetime or cancelling its native operation.
      return this.operations.run(signal, () => pending, () => undefined);
    }
    if (this.running) return Promise.resolve();
    const pending = this.startOnce(signal).finally(() => { if (this.starting === pending) this.starting = undefined; });
    this.starting = pending;
    return pending;
  }

  private async startOnce(signal: AbortSignal): Promise<void> {
    if (this.stopping) await this.stopping;
    if (signal.aborted) throw abortError();
    if (this.running) return;
    if (this.stopFailed) throw new Error('BLE teardown failed; recreate the radio before restarting');
    const generation = ++this.generation;
    const status = await this.status(signal);
    if (generation !== this.generation || signal.aborted) throw abortError();
    this.events.emit({ type: 'status', status });
    if (!status.available) throw new Error(`BLE unavailable: ${status.reason ?? 'unavailable'}`);
    this.running = true;
    const onAbort = (): void => { if (generation === this.generation) ignoreFailure(() => this.stop()); };
    signal.addEventListener('abort', onAbort, { once: true });
    this.subscriptions.push(() => signal.removeEventListener('abort', onAbort));
    try {
      const stateSub = this.manager!.onStateChange(state => {
        if (!this.isCurrent(generation)) return;
        const updated = this.statusForState(state);
        this.events.emit({ type: 'status', status: updated });
        if (!updated.available) ignoreFailure(() => this.stop());
      });
      if (!this.isCurrent(generation) || signal.aborted) { stateSub.remove(); throw abortError(); }
      this.subscriptions.push(() => stateSub.remove());
      if (this.options.peripheral) {
        this.subscriptions.push(this.options.peripheral.subscribe(event => {
          if (this.isCurrent(generation)) this.onPeripheralEvent(event);
        }));
        await this.operations.run(signal, () => this.options.peripheral!.start(signal), () => { ignoreFailure(() => this.options.peripheral!.stop()); });
      }
      if (!this.isCurrent(generation) || signal.aborted) throw abortError();
      await this.operations.run(signal, () => this.manager!.startDeviceScan([PALMESH_BLE_SERVICE], { allowDuplicates: false }, (error, device) => {
        if (!this.isCurrent(generation)) return;
        if (error) { this.events.emit({ type: 'error', error }); ignoreFailure(() => this.stop()); return; }
        if (!device || !isRadioId(device.id)) return;
        const rssi = device.rssi;
        this.events.emit({ type: 'discovered', endpoint: { endpointId: device.id,
          ...(typeof rssi === 'number' && Number.isFinite(rssi) && rssi >= -200 && rssi <= 20 ? { rssi } : {}) } });
      }), () => { ignoreFailure(() => this.manager!.stopDeviceScan()); });
      if (!this.isCurrent(generation) || signal.aborted) throw abortError();
    } catch (error) {
      if (generation === this.generation) ignoreFailure(() => this.stop());
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    ++this.generation;
    this.operations.cancelAll();
    for (const unsubscribe of this.subscriptions.splice(0)) ignoreFailure(unsubscribe);
    const endpoints = new Set([...this.pendingEndpoints, ...[...this.central.values()].map(entry => entry.link.endpointId)]);
    for (const entry of this.central.values()) this.releaseCentral(entry, false);
    this.central.clear();
    for (const entry of this.hosted.values()) this.events.emit({ type: 'disconnected', linkId: entry.link.id });
    this.hosted.clear();
    this.hostedByNative.clear();
    if (!this.manager && !this.options.peripheral) return Promise.resolve();
    const stop = this.operations.run(undefined, async () => {
      const tasks: Promise<unknown>[] = [];
      if (this.manager) {
        tasks.push(this.manager.stopDeviceScan());
        for (const endpoint of endpoints) tasks.push(this.manager.cancelDeviceConnection(endpoint));
      }
      if (this.options.peripheral) tasks.push(this.options.peripheral.stop());
      const results = await Promise.allSettled(tasks);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }, () => undefined);
    this.stopping = stop.catch(error => { this.stopFailed = true; throw error; }).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  async connect(endpointId: string, signal: AbortSignal): Promise<RadioLink> {
    if (!this.running || !this.manager) throw new Error('BLE is not started');
    if (!isRadioId(endpointId)) throw new Error('Invalid BLE endpoint');
    if (signal.aborted) throw abortError();
    if (this.pendingEndpoints.has(endpointId) || [...this.central.values()].some(entry => entry.link.endpointId === endpointId)) throw new Error('BLE endpoint already connecting or connected');
    if (this.central.size + this.pendingEndpoints.size >= this.maxConnections) throw new Error('BLE connection capacity reached');
    const generation = this.generation;
    this.pendingEndpoints.add(endpointId);
    let launched = false;
    const check = (): void => { if (!this.isCurrent(generation) || signal.aborted) throw abortError(); };
    try {
      return await this.operations.run(signal, async (transactionId, isActive) => {
        launched = true;
        let entry: CentralLink | undefined;
        let accepted = false;
        const checkActive = (): void => { check(); if (!isActive()) throw abortError(); };
        try {
          const device = await this.manager!.connectToDevice(endpointId, { requestMTU: 517, timeout: 12_000 });
          checkActive();
          if (device.id !== endpointId) throw new Error('BLE returned another endpoint');
          const discovered = await this.manager!.discoverAllServicesAndCharacteristicsForDevice(endpointId, transactionId);
          checkActive();
          const mtu = discovered.mtu;
          if (!Number.isInteger(mtu) || mtu < 23 || mtu > 517) throw new Error('Invalid BLE MTU');
          const link: RadioLink = { id: `ble-${this.instance}-${generation}-${++this.sequence}`, endpointId,
            maxChunkBytes: Math.min(mtu - 3, 512) };
          entry = { link, monitorId: `${transactionId}-notify`, subscriptions: [], released: false, published: false, earlyData: [], earlyBytes: 0 };
          const activeEntry = entry;
          this.central.set(link.id, entry);
          this.addSubscription(entry, this.manager!.onDeviceDisconnected(endpointId, (error) => {
            if (this.central.get(link.id) !== activeEntry || !this.isCurrent(generation)) return;
            if (error) this.events.emit({ type: 'error', error });
            this.central.delete(link.id);
            this.releaseCentral(activeEntry, false);
          }));
          this.addSubscription(entry, this.manager!.monitorCharacteristicForDevice(endpointId, PALMESH_BLE_SERVICE, PALMESH_BLE_NOTIFY, (error, characteristic) => {
            if (this.central.get(link.id) !== activeEntry || !this.isCurrent(generation)) return;
            if (error) { this.events.emit({ type: 'error', error }); ignoreFailure(() => this.disconnect(link.id)); return; }
            try {
              const value = characteristic?.value;
              if (typeof value !== 'string' || value.length > Math.ceil(link.maxChunkBytes / 3) * 4) throw new Error('Invalid BLE notification');
              const bytes = base64ToBytes(value);
              if (bytes.length < 1 || bytes.length > link.maxChunkBytes) throw new Error('BLE notification exceeds negotiated MTU');
              if (!activeEntry.published) {
                if (activeEntry.earlyData.length >= 8 || activeEntry.earlyBytes + bytes.length > 4096) throw new Error('BLE notification arrived before link setup capacity');
                activeEntry.earlyData.push(bytes);
                activeEntry.earlyBytes += bytes.length;
              } else this.events.emit({ type: 'data', linkId: link.id, bytes });
            } catch (error) { this.events.emit({ type: 'error', error }); ignoreFailure(() => this.disconnect(link.id)); }
          }, entry.monitorId));
          checkActive();
          if (this.central.get(link.id) !== entry) throw new Error('BLE disconnected during setup');
          this.events.emit({ type: 'connected', link });
          // Some native emitters invoke callbacks while monitor registration is
          // still unwinding. Publish the link before delivering those bytes.
          // Bound a pathological reentrant subscriber as well as native backlog.
          let drained = 0;
          while (entry.earlyData.length > 0) {
            if (drained++ >= 32) throw new Error('BLE notification setup backlog exceeded');
            checkActive();
            if (this.central.get(link.id) !== entry) throw new Error('BLE disconnected during setup');
            const bytes = entry.earlyData.shift()!;
            entry.earlyBytes -= bytes.length;
            this.events.emit({ type: 'data', linkId: link.id, bytes });
          }
          entry.published = true;
          accepted = true;
          return link;
        } finally {
          this.pendingEndpoints.delete(endpointId);
          if (!accepted) {
            if (entry) { if (this.central.get(entry.link.id) === entry) this.central.delete(entry.link.id); this.releaseCentral(entry); }
            else ignoreFailure(() => this.manager!.cancelDeviceConnection(endpointId));
          }
        }
      }, transactionId => {
        ignoreFailure(() => this.manager!.cancelTransaction(transactionId));
        ignoreFailure(() => this.manager!.cancelDeviceConnection(endpointId));
      }, late => { ignoreFailure(() => this.disconnect(late.id)); });
    } catch (error) {
      // Keep the endpoint reserved while a cancelled native connect is pending:
      // a late completion must not disconnect a replacement connection.
      if (!launched) this.pendingEndpoints.delete(endpointId);
      throw error;
    }
  }

  async disconnect(linkId: string): Promise<void> {
    this.operations.cancelOwner(linkId);
    const host = this.hosted.get(linkId);
    if (host) {
      this.hosted.delete(linkId);
      this.hostedByNative.delete(host.nativeId);
      this.events.emit({ type: 'disconnected', linkId });
      await this.operations.run(undefined, () => this.options.peripheral!.disconnect(host.nativeId), () => undefined);
      return;
    }
    const entry = this.central.get(linkId);
    if (!entry) return;
    this.central.delete(linkId);
    this.releaseCentral(entry, false);
    await this.operations.run(undefined, () => this.manager!.cancelDeviceConnection(entry.link.endpointId), () => undefined);
  }

  async write(linkId: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    if (!this.running) throw new Error('BLE is not started');
    const entry = this.central.get(linkId);
    const host = this.hosted.get(linkId);
    const link = entry?.link ?? host?.link;
    if (!link) throw new Error('BLE link is closed');
    if (bytes.length < 1 || bytes.length > link.maxChunkBytes) throw new Error('BLE chunk exceeds negotiated MTU');
    if (host) {
      const payload = bytes.slice();
      let nativeStarted = false;
      await this.operations.run(signal, (_id, isActive) => this.writes.run(linkId, () => {
        if (!isActive() || !this.running || this.hosted.get(linkId) !== host || signal.aborted) throw abortError();
        nativeStarted = true;
        return this.options.peripheral!.write(host.nativeId, payload, signal);
      }), () => { if (nativeStarted) ignoreFailure(() => this.disconnect(linkId)); }, undefined, linkId);
      return;
    }
    // ATT write-with-response confirms GATT receipt, not SQLite commit. The
    // transport waits for a separate wire ACK before DTN delivery succeeds.
    const payload = bytesToBase64(bytes);
    let nativeStarted = false;
    await this.operations.run(signal, (transactionId, isActive) => this.writes.run(linkId, () => {
      if (!isActive() || !this.running || this.central.get(linkId) !== entry || signal.aborted) throw abortError();
      nativeStarted = true;
      return this.manager!.writeCharacteristicWithResponseForDevice(
        link.endpointId, PALMESH_BLE_SERVICE, PALMESH_BLE_WRITE, payload, transactionId);
    }), transactionId => {
      ignoreFailure(() => this.manager!.cancelTransaction(transactionId));
      if (nativeStarted) ignoreFailure(() => this.disconnect(linkId));
    }, undefined, linkId);
  }

  private isCurrent(generation: number): boolean { return this.running && generation === this.generation; }
  private statusForState(state: string): RadioStatus {
    switch (state) {
      case 'PoweredOn': return { available: true };
      case 'Unauthorized': return { available: false, reason: 'permission-denied' };
      case 'PoweredOff': return { available: false, reason: 'powered-off' };
      case 'Unsupported': return { available: false, reason: 'unsupported' };
      default: return { available: false, reason: 'unavailable' };
    }
  }

  private addSubscription(entry: CentralLink, subscription: BlePlxSubscription): void {
    if (entry.released) ignoreFailure(() => subscription.remove());
    else entry.subscriptions.push(subscription);
  }

  private releaseCentral(entry: CentralLink, disconnect = true): void {
    if (entry.released) return;
    entry.released = true;
    entry.earlyData.length = 0;
    entry.earlyBytes = 0;
    this.operations.cancelOwner(entry.link.id);
    for (const subscription of entry.subscriptions) ignoreFailure(() => subscription.remove());
    ignoreFailure(() => this.manager!.cancelTransaction(entry.monitorId));
    if (disconnect) ignoreFailure(() => this.manager!.cancelDeviceConnection(entry.link.endpointId));
    this.events.emit({ type: 'disconnected', linkId: entry.link.id });
  }

  private onPeripheralEvent(event: RadioEvent): void {
    if (event.type === 'connected') {
      if (!isRadioLink(event.link) || event.link.maxChunkBytes > 512) { this.events.emit({ type: 'error', error: new Error('Invalid BLE peripheral link') }); return; }
      if (this.hostedByNative.has(event.link.id)) return;
      if (this.hosted.size >= this.maxConnections) { ignoreFailure(() => this.options.peripheral!.disconnect(event.link.id)); return; }
      const link = { ...event.link, id: `ble-host-${this.instance}-${this.generation}-${++this.sequence}` };
      this.hosted.set(link.id, { nativeId: event.link.id, link });
      this.hostedByNative.set(event.link.id, link.id);
      this.events.emit({ type: 'connected', link });
    } else if (event.type === 'data' || event.type === 'disconnected') {
      const linkId = this.hostedByNative.get(event.linkId);
      if (!linkId) return;
      if (event.type === 'disconnected') {
        this.operations.cancelOwner(linkId);
        this.hosted.delete(linkId);
        this.hostedByNative.delete(event.linkId);
        this.events.emit({ type: 'disconnected', linkId });
      } else {
        const link = this.hosted.get(linkId)!.link;
        if (event.bytes.length < 1 || event.bytes.length > link.maxChunkBytes) {
          this.events.emit({ type: 'error', error: new Error('BLE peripheral data exceeds link limit') });
          ignoreFailure(() => this.disconnect(linkId));
        } else this.events.emit({ type: 'data', linkId, bytes: event.bytes.slice() });
      }
    } else if (event.type === 'error') this.events.emit(event);
    // Central discovery owns outbound endpoints. Peripheral status should not
    // mark central scanning unavailable; surface its failures independently.
    else if (event.type === 'status' && !event.status.available) this.events.emit({ type: 'error', error: new Error(`BLE peripheral unavailable: ${event.status.reason ?? 'unavailable'}`) });
  }
}
