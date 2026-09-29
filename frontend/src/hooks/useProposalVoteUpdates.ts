// ============================================================
// BANKERCHANGER — useProposalVoteUpdates Hook
// Subscribes to governance:vote_update WebSocket events for a
// single proposal and forwards them to the caller.
// ============================================================

import { useEffect, useRef } from 'react';

export interface VoteUpdatePayload {
  type: 'governance:vote_update';
  proposalId: string;
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  voter?: string;
  timestamp?: string;
}

function toWebSocketUrl(baseUrl: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = new URL(baseUrl);
    const protocol =
      parsed.protocol === 'https:' ? 'wss:' : parsed.protocol === 'http:' ? 'ws:' : null;
    if (!protocol) return null;
    parsed.protocol = protocol;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Subscribes to the governance WebSocket feed and invokes `onUpdate` whenever
 * a `governance:vote_update` message arrives for the given proposal.
 *
 * The connection is opened on mount and closed on unmount. Malformed messages
 * and messages for other proposals are ignored.
 */
export function useProposalVoteUpdates(
  proposalId: string,
  onUpdate: (payload: VoteUpdatePayload) => void,
): void {
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (!proposalId) return;
    if (typeof window === 'undefined' || typeof window.WebSocket === 'undefined') return;

    const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
    const socketUrl = toWebSocketUrl(apiBaseUrl);
    if (!socketUrl) return;

    const socket = new window.WebSocket(socketUrl);

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'subscribe_governance_votes',
          proposalId,
        }),
      );
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data as string) as Partial<VoteUpdatePayload>;
        if (
          payload?.type !== 'governance:vote_update' ||
          payload.proposalId !== proposalId ||
          payload.votesFor === undefined ||
          payload.votesAgainst === undefined ||
          payload.votesAbstain === undefined
        ) {
          return;
        }
        onUpdateRef.current(payload as VoteUpdatePayload);
      } catch {
        // Ignore malformed messages.
      }
    });

    return () => socket.close();
  }, [proposalId]);
}