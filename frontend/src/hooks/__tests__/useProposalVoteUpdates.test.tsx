import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useProposalVoteUpdates, VoteUpdatePayload } from '../../hooks/useProposalVoteUpdates';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  public listeners: Record<string, Array<(event: MessageEvent) => void>> = {};
  public readyState = 1;
  public sentMessages: string[] = [];
  public close = jest.fn();

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    this.listeners[type] = this.listeners[type] ?? [];
    this.listeners[type].push(handler);
  }

  send(message: string) {
    this.sentMessages.push(message);
  }

  emitMessage(payload: string) {
    this.listeners.message?.forEach((handler) => handler({ data: payload } as MessageEvent));
  }

  open() {
    this.listeners.open?.forEach((handler) => handler({} as MessageEvent));
  }
}

function Probe({ onUpdate }: { onUpdate: (p: VoteUpdatePayload) => void }) {
  useProposalVoteUpdates('prop_1', onUpdate);
  return <div data-testid="probe">mounted</div>;
}

describe('useProposalVoteUpdates', () => {
  const originalWebSocket = window.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    window.WebSocket = originalWebSocket;
    jest.clearAllMocks();
  });

  it('subscribes to the governance feed on open', () => {
    render(<Probe onUpdate={jest.fn()} />);

    const socket = MockWebSocket.instances[0];
    expect(socket).toBeDefined();

    socket.open();
    expect(socket.sentMessages).toContain(
      JSON.stringify({ type: 'subscribe_governance_votes', proposalId: 'prop_1' }),
    );
  });

  it('forwards governance:vote_update payloads for the matching proposal', async () => {
    const onUpdate = jest.fn();
    render(<Probe onUpdate={onUpdate} />);

    const socket = MockWebSocket.instances[0];
    socket.emitMessage(
      JSON.stringify({
        type: 'governance:vote_update',
        proposalId: 'prop_1',
        votesFor: 60000,
        votesAgainst: 15000,
        votesAbstain: 5000,
      }),
    );

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: 'prop_1',
        votesFor: 60000,
        votesAgainst: 15000,
        votesAbstain: 5000,
      }),
    );
  });

  it('ignores updates for other proposals', () => {
    const onUpdate = jest.fn();
    render(<Probe onUpdate={onUpdate} />);

    const socket = MockWebSocket.instances[0];
    socket.emitMessage(
      JSON.stringify({
        type: 'governance:vote_update',
        proposalId: 'prop_2',
        votesFor: 1,
        votesAgainst: 0,
        votesAbstain: 0,
      }),
    );

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('ignores malformed messages without throwing', () => {
    const onUpdate = jest.fn();
    render(<Probe onUpdate={onUpdate} />);

    const socket = MockWebSocket.instances[0];
    expect(() => socket.emitMessage('not json')).not.toThrow();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});