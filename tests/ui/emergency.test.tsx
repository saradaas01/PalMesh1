import React from 'react';
import { expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { EmergencyBanner, EmergencyInbox, type EmergencyUiService } from '../../src/features/emergency/ui';
import type { EmergencyEntry, EmergencySnapshot } from '../../src/features/emergency';
import { I18nProvider } from '../../src/shared/i18n';

const incoming: EmergencyEntry = { id: 'sos-1', source: 'peer-bob', text: 'Please send water', createdAt: 1_000,
  receivedAt: 1_000, expiresAt: 20_000, outgoing: false, dismissed: false, responseId: null, responses: [] };
function service(entries: readonly EmergencyEntry[]): EmergencyUiService {
  const snapshot: EmergencySnapshot = { status: 'ready', entries, urgent: entries[0] ?? null,
    pendingResponseIds: [], issue: null, now: 2_000 };
  return { getSnapshot: () => snapshot, subscribe: () => () => undefined, refresh: jest.fn(async () => undefined),
    respond: jest.fn(async () => ({ status: 'queued' as const, messageId: 'response-1' })), dismiss: jest.fn(async () => undefined) };
}

test('incoming SOS can be reviewed or answered without implying rescue or opening a modal', async () => {
  const inbox = service([incoming]); await render(<EmergencyInbox service={inbox} />);
  expect(screen.getByText('Please send water')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button',{name:'How SOS works'}));
  expect(screen.getByText('A response is a statement of intent. Assistance is not confirmed.')).toBeOnTheScreen();
  const respond = screen.getByRole('button', { name: 'I can respond' });
  expect(respond.props.accessibilityHint).toContain('Does not share your location');
  await fireEvent.press(respond); expect(inbox.respond).toHaveBeenCalledWith('sos-1');
  await fireEvent.press(screen.getByRole('button', { name: 'Mark reviewed' })); expect(inbox.dismiss).toHaveBeenCalledWith('sos-1');
});

test('outgoing SOS renders responder intent separately from any delivery acknowledgment', async () => {
  const inbox = service([{ ...incoming, outgoing: true, source: 'local', responses: [{
    id: 'response-1', responder: 'peer-carol', receivedAt: 1_500, status: 'responding',
  }] }]);
  await render(<EmergencyInbox service={inbox} />);
  expect(screen.getByText('peer-carol says they are responding')).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'I can respond' })).toBeNull();
});

test('urgent banner exposes navigation and Arabic inbox is available with RTL text', async () => {
  const inbox = service([incoming]); const onOpen = jest.fn();
  const view = await render(<EmergencyBanner service={inbox} onOpen={onOpen} />);
  expect(screen.getByRole('alert')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Open SOS inbox' })); expect(onOpen).toHaveBeenCalledTimes(1);
  await view.unmount();
  await render(<I18nProvider initialLanguage="ar"><EmergencyInbox service={inbox} /></I18nProvider>);
  expect(screen.queryByText('SOS inbox')).toBeNull();
  expect(screen.getByText('Please send water')).toHaveStyle({ writingDirection: 'rtl' });
});
