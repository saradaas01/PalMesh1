import React from 'react';
import { LocalizedText as Text, useI18n } from '../../shared/i18n';
import type { AppSnapshot } from '../domain/types';

/** Peer count comes from authenticated mesh sessions, never radio availability. */
export function ConnectionSummary({ snapshot }: { readonly snapshot: Pick<AppSnapshot, 'connectedPeers'> }): React.JSX.Element {
  const { t } = useI18n();
  return <Text style={{ fontSize: 12, lineHeight: 18, color: '#536B75' }}>{snapshot.connectedPeers > 0
    ? t(snapshot.connectedPeers === 1 ? 'common.connectedPeer' : 'common.connectedPeers', { count: snapshot.connectedPeers })
    : t('ui.waiting')}</Text>;
}
