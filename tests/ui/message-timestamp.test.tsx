import React from 'react';
import { expect, test } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { MessageTimestamp } from '../../src/features/chat/ui/MessageTimestamp';
import { I18nProvider, translate } from '../../src/shared/i18n';
import { formatMessageTimestamps } from '../../src/shared/time/messageTimestamps';

const createdAt = Date.UTC(2026, 10, 5, 10, 0);
const receivedAt = Date.UTC(2026, 10, 5, 10, 25);

test('shows original sender time and describes separate receipt time as local storage', async () => {
  const formatted = formatMessageTimestamps({ createdAt, receivedAt });
  await render(<I18nProvider><MessageTimestamp createdAt={createdAt} receivedAt={receivedAt} testID="timestamp" /></I18nProvider>);
  const stamp = screen.getByTestId('timestamp');
  expect(stamp).toHaveTextContent(translate('en', 'chat.timestamp.sender', { time: formatted.sent! }));
  expect(stamp).toHaveProp('accessibilityLabel', [
    translate('en', 'chat.timestamp.sender', { time: formatted.sent! }),
    translate('en', 'chat.timestamp.unverified'),
    translate('en', 'chat.timestamp.received', { time: formatted.received! }),
  ].join('. '));
  expect(stamp).not.toHaveTextContent(translate('en', 'chat.timestamp.received', { time: formatted.received! }));
});

test('flags sender clock discrepancy in Arabic without relabeling receipt as sending', async () => {
  const future = receivedAt + 60 * 60_000;
  const formatted = formatMessageTimestamps({ createdAt: future, receivedAt });
  await render(<I18nProvider initialLanguage="ar"><MessageTimestamp createdAt={future} receivedAt={receivedAt} testID="timestamp" /></I18nProvider>);
  const stamp = screen.getByTestId('timestamp');
  expect(stamp).toHaveTextContent(`${translate('ar', 'chat.timestamp.sender', { time: formatted.sent! })} · ${translate('ar', 'chat.timestamp.clockWarning')}`);
  expect(stamp).toHaveProp('accessibilityLanguage', 'ar-JO');
});

test('malformed sender time renders unavailable and retains receipt only in its separate description', async () => {
  await render(<MessageTimestamp createdAt={NaN} receivedAt={receivedAt} testID="timestamp" />);
  const stamp = screen.getByTestId('timestamp');
  expect(stamp).toHaveTextContent(translate('en', 'chat.timestamp.unavailable'));
  expect(stamp).not.toHaveTextContent(translate('en', 'chat.timestamp.sender', { time: formatMessageTimestamps({ createdAt: receivedAt }).sent! }));
});
