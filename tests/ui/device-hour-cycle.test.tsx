import React from 'react';
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { AppState, NativeModules, Text, View } from 'react-native';
import { act, render, screen } from '@testing-library/react-native';
import { useDeviceHourCycle } from '../../src/shared/time/useDeviceHourCycle';

const originalBridge = NativeModules.PalMeshRuntime;
let onState: ((state: 'active' | 'background' | 'inactive') => void) | undefined;
let remove: ReturnType<typeof jest.fn>;
beforeEach(() => {
  remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    onState = listener;
    return { remove };
  });
});
afterEach(() => { NativeModules.PalMeshRuntime = originalBridge; onState = undefined; });

function Clock({ id = 'clock' }: { id?: string }) {
  const value = useDeviceHourCycle();
  return <Text testID={id}>{value === undefined ? 'locale' : value ? '12-hour' : '24-hour'}</Text>;
}
function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

for (const [value, label] of [[true, '12-hour'], [false, '24-hour']] as const) {
  test(`reads native ${label} preference`, async () => {
    const getClockFormat = jest.fn(async () => value);
    NativeModules.PalMeshRuntime = { getClockFormat };
    const view = await render(<Clock/>);
    await flush();
    expect(screen.getByTestId('clock')).toHaveTextContent(label);
    expect(getClockFormat).toHaveBeenCalledTimes(1);
    await view.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });
}

test('many timestamp consumers share one native query and AppState listener', async () => {
  const getClockFormat = jest.fn(async () => false);
  NativeModules.PalMeshRuntime = { getClockFormat };
  const view = await render(<View><Clock id="one"/><Clock id="two"/><Clock id="three"/></View>);
  await flush();
  expect(getClockFormat).toHaveBeenCalledTimes(1);
  expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
  for (const id of ['one', 'two', 'three']) expect(screen.getByTestId(id)).toHaveTextContent('24-hour');
  await view.unmount();
  expect(remove).toHaveBeenCalledTimes(1);
});

test('a failed or unavailable native read uses locale fallback', async () => {
  NativeModules.PalMeshRuntime = { getClockFormat: jest.fn(async () => { throw new Error('native detail never retained'); }) };
  const view = await render(<Clock/>);
  await flush();
  expect(screen.getByTestId('clock')).toHaveTextContent('locale');
  NativeModules.PalMeshRuntime = undefined;
  await act(async () => { onState?.('active'); });
  await flush();
  expect(screen.getByTestId('clock')).toHaveTextContent('locale');
  await view.unmount();
});

test('an unlinked native host uses locale fallback without adding a foreground listener', async () => {
  NativeModules.PalMeshRuntime = undefined;
  const view = await render(<Clock/>);
  await flush();
  expect(screen.getByTestId('clock')).toHaveTextContent('locale');
  expect(AppState.addEventListener).not.toHaveBeenCalled();
  await view.unmount();
});

test('returning from Settings refreshes the shared preference', async () => {
  const getClockFormat = jest.fn<() => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  NativeModules.PalMeshRuntime = { getClockFormat };
  const view = await render(<Clock/>);
  await flush();
  expect(screen.getByTestId('clock')).toHaveTextContent('12-hour');
  await act(async () => { onState?.('background'); });
  expect(getClockFormat).toHaveBeenCalledTimes(1);
  await act(async () => { onState?.('active'); });
  await flush();
  expect(screen.getByTestId('clock')).toHaveTextContent('24-hour');
  expect(getClockFormat).toHaveBeenCalledTimes(2);
  await view.unmount();
});

test('an older async read cannot override a foreground refresh', async () => {
  const old = deferred(); const current = deferred();
  const getClockFormat = jest.fn<() => Promise<boolean>>().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  NativeModules.PalMeshRuntime = { getClockFormat };
  const view = await render(<Clock/>);
  await flush();
  await act(async () => { onState?.('background'); onState?.('active'); current.resolve(false); });
  await flush();
  expect(screen.getByTestId('clock')).toHaveTextContent('24-hour');
  await act(async () => { old.resolve(true); });
  await flush();
  expect(screen.getByTestId('clock')).toHaveTextContent('24-hour');
  await view.unmount();
});

test('unmounted requests cannot overwrite a later mounted session', async () => {
  const old = deferred(); const current = deferred();
  const getClockFormat = jest.fn<() => Promise<boolean>>().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  NativeModules.PalMeshRuntime = { getClockFormat };
  const first = await render(<Clock/>);
  await flush();
  await first.unmount();
  const next = await render(<Clock/>);
  await flush();
  await act(async () => { current.resolve(false); });
  await flush();
  await act(async () => { old.resolve(true); });
  await flush();
  expect(screen.getByTestId('clock')).toHaveTextContent('24-hour');
  expect(getClockFormat).toHaveBeenCalledTimes(2);
  await next.unmount();
});
