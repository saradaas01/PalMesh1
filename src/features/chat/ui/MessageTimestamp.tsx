import React from 'react';
import type { TextProps } from 'react-native';
import { LocalizedText, useI18n } from '../../../shared/i18n';
import { useDeviceHourCycle } from '../../../shared/time/useDeviceHourCycle';
import { formatMessageTimestamps } from '../../../shared/time/messageTimestamps';

export interface MessageTimestampProps {
  readonly createdAt: number;
  readonly receivedAt?: number;
  readonly style?: TextProps['style'];
  readonly testID?: string;
}

/** Shared by message history and conversation previews. Device-local formatting
 * keeps the signed sender time visible; accessibility describes its limits and
 * the independently stored receipt time without confusing the two. */
export function MessageTimestamp({ createdAt, receivedAt, style, testID }: MessageTimestampProps): React.JSX.Element {
  const { t } = useI18n();
  const hour12 = useDeviceHourCycle();
  const formatted = formatMessageTimestamps({ createdAt, receivedAt }, typeof hour12 === 'boolean' ? {hour12} : {});
  const sender = formatted.sent === null ? t('chat.timestamp.unavailable')
    : t('chat.timestamp.sender', { time: formatted.sent });
  const warning = formatted.sent !== null && formatted.clockIssue !== null
    ? t('chat.timestamp.clockWarning') : null;
  const label = [sender, t('chat.timestamp.unverified'),
    ...(formatted.received === null ? [] : [t('chat.timestamp.received', { time: formatted.received })]),
    ...(warning === null ? [] : [warning]),
  ].join('. ');
  return <LocalizedText style={style} testID={testID} accessibilityLabel={label}>
    {sender}{warning === null ? '' : ` · ${warning}`}
  </LocalizedText>;
}
