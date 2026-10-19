import React from 'react';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen, userEvent } from '@testing-library/react-native';
import { AppState, BackHandler } from 'react-native';
import type { ChatActionResult, ChatMessage, ChatSnapshot, Conversation } from '../../src/features/chat/domain/types';
import { PalMeshChatApp } from '../../src/features/chat/ui/PalMeshChatApp';
import type { ChatUiService } from '../../src/features/chat/ui/ChatProvider';

const NOW = 1_800_000_000_000;
const initialAppState = AppState.currentState;
afterEach(() => { AppState.currentState = initialAppState; });

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'first-message', sequence: 1, conversationId: 'peer-alice', source: 'peer-alice',
    destination: 'local-device', kind: 'chat', text: 'Can you hear me?',
    createdAt: NOW, receivedAt: NOW, expiresAt: NOW + 60_000,
    outgoing: false, peerStored: false, read: false, ...overrides,
  };
}

function conversation(entry: ChatMessage): Conversation {
  return { id: entry.conversationId, lastMessage: entry, unreadCount: entry.read ? 0 : 1 };
}

/** A reactive application-boundary fake: no native mocks or radio behavior in UI tests. */
class ReactiveChatService implements ChatUiService {
  readonly deviceId = 'local-device';
  private readonly listeners = new Set<() => void>();
  archive: ChatMessage[] = [message()];
  snapshot: ChatSnapshot = {
    status: 'idle', conversations: [conversation(this.archive[0]!)], messages: [],
    selectedConversationId: null, connectedPeers: [], draft: '', pendingSend: false,
    pendingSos: false, hasOlderMessages: false, issue: null, notice: null, now: NOW,
  };
  rejectSend = false;
  sosGate: Promise<void> | null = null;

  patch(change: Partial<ChatSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...change });
    for (const listener of this.listeners) listener();
  }
  getSnapshot = (): ChatSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  start = jest.fn(async (): Promise<void> => { this.patch({ status: 'ready' }); });
  stop = jest.fn(async (): Promise<void> => {});
  setVisible = jest.fn((_visible: boolean): void => {});
  openConversation = jest.fn(async (id: string): Promise<void> => {
    this.patch({ selectedConversationId: id, messages: this.archive.filter((entry) => entry.conversationId === id), draft: '' });
  });
  closeConversation = jest.fn((): void => { this.patch({ selectedConversationId: null }); });
  setDraft = jest.fn((draft: string): void => { this.patch({ draft }); });
  send = jest.fn(async (): Promise<ChatActionResult> => {
    if (this.rejectSend) {
      this.patch({ issue: 'queue-full' });
      return { status: 'rejected', reason: 'capacity' };
    }
    const entry = message({
      id: 'new-message', sequence: 2, source: this.deviceId,
      destination: this.snapshot.selectedConversationId!, conversationId: this.snapshot.selectedConversationId!,
      text: this.snapshot.draft, outgoing: true, read: true,
    });
    this.archive.push(entry);
    this.patch({ messages: [...this.snapshot.messages, entry], draft: '', notice: { kind: 'chat-queued', messageId: entry.id } });
    return { status: 'queued', messageId: entry.id };
  });
  sendSos = jest.fn(async (): Promise<ChatActionResult> => {
    this.patch({ pendingSos: true });
    if (this.sosGate !== null) await this.sosGate;
    this.patch({ pendingSos: false, notice: { kind: 'sos-queued', messageId: 'sos-message' } });
    return { status: 'queued', messageId: 'sos-message' };
  });
  loadOlder = jest.fn(async (): Promise<void> => { this.patch({ hasOlderMessages: false }); });
  refresh = jest.fn(async (): Promise<void> => { this.patch({ status: 'ready', issue: null }); });
  dismissIssue = jest.fn((): void => { this.patch({ issue: null }); });
  dismissNotice = jest.fn((): void => { this.patch({ notice: null }); });
}

async function openAlice(): Promise<void> {
  await fireEvent.press(screen.getByRole('button', { name: 'Open conversation with peer-alice, 1 unread' }));
}

describe('PalMesh chat UI', () => {
  test('subscribes on mount, releases chat lifecycle on unmount, and shows unread inbox', async () => {
    const service = new ReactiveChatService();
    const view = await render(<PalMeshChatApp service={service} />);
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1 unread')).toBeOnTheScreen();
    expect(screen.getByText('Your peer ID: local-device')).toBeOnTheScreen();
    expect(screen.getByText('Messages are not encrypted yet.')).toBeOnTheScreen();
    await view.unmount();
    expect(service.stop).toHaveBeenCalledTimes(1);
  });

  test('opens a thread, queues Arabic and emoji text, and returns to inbox', async () => {
    const service = new ReactiveChatService();
    const user = userEvent.setup();
    await render(<PalMeshChatApp service={service} />);
    await openAlice();
    expect(screen.getByText('Can you hear me?')).toBeOnTheScreen();
    const composer = screen.getByLabelText('Message');
    expect(composer.props.maxLength).toBe(4096);
    await user.type(composer, 'نحن هنا 🕊️');
    expect(service.setDraft).toHaveBeenLastCalledWith('نحن هنا 🕊️');
    await user.press(screen.getByRole('button', { name: 'Send message' }));
    expect(service.send).toHaveBeenCalledTimes(1);
    expect(screen.getByText('نحن هنا 🕊️')).toBeOnTheScreen();
    expect(screen.getByLabelText('Message')).toHaveDisplayValue('');
    expect(screen.getByText(/Queued locally/)).toBeOnTheScreen();
    expect(screen.getByText('Message queued on this device. Delivery is not confirmed.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to messages' }));
    expect(service.closeConversation).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('header', { name: 'Messages' })).toBeOnTheScreen();
  });

  test('keeps a failed-send draft and makes SOS reachable while the queue is full', async () => {
    const service = new ReactiveChatService();
    service.rejectSend = true;
    await render(<PalMeshChatApp service={service} />);
    await openAlice();
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Please keep this draft');
    await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
    expect(screen.getByLabelText('Message')).toHaveDisplayValue('Please keep this draft');
    expect(screen.getByRole('alert')).toHaveTextContent(/The local queue is full\./);
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(service.sendSos).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Receipt or help is not confirmed/)).toBeOnTheScreen();
  });

  test('renders live messages, honest custody labels, and connection counts', async () => {
    const service = new ReactiveChatService();
    await render(<PalMeshChatApp service={service} />);
    await openAlice();
    await act(async () => {
      service.patch({
        connectedPeers: ['peer-relay'],
        messages: [
          message(),
          message({ id: 'queued', sequence: 2, text: 'Awaiting route', outgoing: true, source: service.deviceId, destination: 'peer-alice' }),
          message({ id: 'stored', sequence: 3, text: 'A peer has it', outgoing: true, source: service.deviceId, destination: 'peer-alice', peerStored: true }),
          message({ id: 'expired', sequence: 4, text: 'Expired forwarding', outgoing: true, source: service.deviceId, destination: 'peer-alice', expiresAt: NOW - 1 }),
        ],
      });
    });
    expect(screen.getByText('1 connected mesh peer')).toBeOnTheScreen();
    expect(screen.getByText(/Relay connections do not confirm/)).toBeOnTheScreen();
    expect(screen.getByText(/Received on this device/)).toBeOnTheScreen();
    expect(screen.getByText(/Queued locally/)).toBeOnTheScreen();
    expect(screen.getByText(/Stored by a peer/)).toBeOnTheScreen();
    expect(screen.getByText(/Forwarding ended/)).toBeOnTheScreen();
    expect(screen.queryByText(/read by|recipient received|delivered to recipient/i)).toBeNull();
  });

  test('allows an unknown offline peer ID and rejects malformed IDs in the new-message dialog', async () => {
    const service = new ReactiveChatService();
    await render(<PalMeshChatApp service={service} />);
    await fireEvent.press(screen.getByRole('button', { name: 'New message' }));
    await fireEvent.changeText(screen.getByLabelText('Recipient peer ID'), 'bad peer');
    await fireEvent.press(screen.getByRole('button', { name: 'Open conversation' }));
    expect(service.openConversation).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Use a peer ID/);
    await fireEvent.changeText(screen.getByLabelText('Recipient peer ID'), 'unknown-offline-peer');
    await fireEvent.press(screen.getByRole('button', { name: 'Open conversation' }));
    expect(service.openConversation).toHaveBeenLastCalledWith('unknown-offline-peer');
    expect(screen.getByRole('header', { name: 'unknown-offline-peer' })).toBeOnTheScreen();
    expect(screen.getByLabelText('Message')).toBeOnTheScreen();
  });

  test('SOS is one tap away on inbox and two taps from the new-message dialog', async () => {
    const service = new ReactiveChatService();
    await render(<PalMeshChatApp service={service} />);
    const sos = screen.getByRole('button', { name: 'I Need Help · SOS' });
    expect(sos).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'New message' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Close new message' }));
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(service.sendSos).toHaveBeenCalledTimes(1);
  });

  test('blocks repeat SOS presses only while submission is pending', async () => {
    const service = new ReactiveChatService();
    let resolveSos!: () => void;
    service.sosGate = new Promise<void>((resolve) => { resolveSos = resolve; });
    await render(<PalMeshChatApp service={service} />);
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(service.sendSos).toHaveBeenCalledTimes(1);
    await act(async () => { resolveSos(); });
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
  });

  test('keeps SOS available during loading and recovers a history failure', async () => {
    const service = new ReactiveChatService();
    service.start.mockImplementation(async () => { service.patch({ status: 'loading' }); });
    await render(<PalMeshChatApp service={service} />);
    expect(screen.getByLabelText('Loading message history')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
    await act(async () => { service.patch({ status: 'error', issue: 'history-unavailable' }); });
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry loading messages' }));
    expect(service.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('nearby broadcast thread has a normal composer and paginates local history', async () => {
    const service = new ReactiveChatService();
    await render(<PalMeshChatApp service={service} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Nearby broadcasts' }));
    expect(service.openConversation).toHaveBeenLastCalledWith('*');
    expect(screen.getByPlaceholderText('Message nearby devices')).toBeOnTheScreen();
    await act(async () => { service.patch({ hasOlderMessages: true }); });
    await fireEvent.press(screen.getByRole('button', { name: 'Load older messages' }));
    expect(service.loadOlder).toHaveBeenCalledTimes(1);
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Supplies available here');
    await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
    expect(screen.getByText('Supplies available here')).toBeOnTheScreen();
  });

  test('Android hardware back returns from a thread, delegates at inbox, and removes its listener', async () => {
    const subscriptions = new Set<Parameters<typeof BackHandler.addEventListener>[1]>();
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, listener) => {
      subscriptions.add(listener);
      return { remove: () => { subscriptions.delete(listener); } };
    });
    const dispatchBack = (): boolean => [...subscriptions].reverse().some(listener =>
      listener({ type: 'hardwareBackPress', timeStamp: NOW }) === true);
    const service = new ReactiveChatService();
    const view = await render(<PalMeshChatApp service={service} />);
    expect(dispatchBack()).toBe(false);
    await openAlice();
    let handled = false;
    await act(async () => { handled = dispatchBack(); });
    expect(handled).toBe(true);
    expect(service.closeConversation).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('header', { name: 'Messages' })).toBeOnTheScreen();
    expect(dispatchBack()).toBe(false);
    await view.unmount();
    expect(subscriptions.size).toBe(0);
  });

  test('tracks native foreground visibility before startup without stopping background archiving', async () => {
    AppState.currentState = 'active';
    const remove = jest.fn();
    const subscription = jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove });
    const service = new ReactiveChatService();
    const view = await render(<PalMeshChatApp service={service} />);
    expect(service.setVisible).toHaveBeenLastCalledWith(true);
    expect(service.setVisible.mock.invocationCallOrder[0]!).toBeLessThan(service.start.mock.invocationCallOrder[0]!);
    const listener = subscription.mock.calls.find(([event]) => event === 'change')?.[1];
    expect(listener).toBeDefined();
    await act(async () => { listener!('background'); });
    expect(service.setVisible).toHaveBeenLastCalledWith(false);
    expect(service.stop).not.toHaveBeenCalled();
    await act(async () => { listener!('active'); });
    expect(service.setVisible).toHaveBeenLastCalledWith(true);
    await view.unmount();
    expect(remove).toHaveBeenCalled();
    expect(service.stop).toHaveBeenCalledTimes(1);
  });

  test('does not mark unknown native app state as visible during startup', async () => {
    AppState.currentState = null;
    const service = new ReactiveChatService();
    await render(<PalMeshChatApp service={service} />);
    expect(service.setVisible).toHaveBeenLastCalledWith(false);
    expect(service.start).toHaveBeenCalledTimes(1);
  });

  test('keeps a hidden host route unread across foreground transitions and focuses without restarting subscriptions', async () => {
    AppState.currentState = 'active';
    const remove = jest.fn();
    const subscription = jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove });
    const service = new ReactiveChatService();
    const view = await render(<PalMeshChatApp service={service} visible={false} />);
    expect(service.setVisible).toHaveBeenLastCalledWith(false);
    const listener = subscription.mock.calls.find(([event]) => event === 'change')?.[1];
    expect(listener).toBeDefined();
    await act(async () => { listener!('background'); });
    await act(async () => { listener!('active'); });
    expect(service.setVisible.mock.calls.every(([visible]) => !visible)).toBe(true);
    await view.rerender(<PalMeshChatApp service={service} visible />);
    expect(service.setVisible).toHaveBeenLastCalledWith(true);
    await act(async () => { listener!('background'); });
    expect(service.setVisible).toHaveBeenLastCalledWith(false);
    await view.rerender(<PalMeshChatApp service={service} visible={false} />);
    await view.rerender(<PalMeshChatApp service={service} visible />);
    expect(service.setVisible).toHaveBeenLastCalledWith(false);
    await act(async () => { listener!('active'); });
    expect(service.setVisible).toHaveBeenLastCalledWith(true);
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.stop).not.toHaveBeenCalled();
    expect(subscription).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    await view.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
