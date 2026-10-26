import type { BlePlxManager } from '../../features/mesh/infrastructure/radios/BlePlxRadio';

/** CoreBluetooth construction can prompt on iOS. The radio adapter checks its
 * permission port before state/start, so manager creation happens after consent.
 * Stopping a never-started adapter must not accidentally create a manager.
 */
export function lazyBleManager(create: () => BlePlxManager): BlePlxManager {
  let current: BlePlxManager | undefined;
  const manager = (): BlePlxManager => current ??= create();
  return {
    state: () => manager().state(),
    onStateChange: (listener, currentState) => manager().onStateChange(listener, currentState),
    startDeviceScan: (services, options, listener) => manager().startDeviceScan(services, options, listener),
    stopDeviceScan: () => current?.stopDeviceScan() ?? Promise.resolve(),
    connectToDevice: (id, options) => manager().connectToDevice(id, options),
    cancelDeviceConnection: id => current?.cancelDeviceConnection(id) ?? Promise.resolve(),
    discoverAllServicesAndCharacteristicsForDevice: (id, transaction) => manager().discoverAllServicesAndCharacteristicsForDevice(id, transaction),
    monitorCharacteristicForDevice: (id, service, characteristic, listener, transaction) => manager().monitorCharacteristicForDevice(id, service, characteristic, listener, transaction),
    onDeviceDisconnected: (id, listener) => manager().onDeviceDisconnected(id, listener),
    writeCharacteristicWithResponseForDevice: (id, service, characteristic, value, transaction) => manager().writeCharacteristicWithResponseForDevice(id, service, characteristic, value, transaction),
    cancelTransaction: id => current?.cancelTransaction(id) ?? Promise.resolve(),
  };
}
