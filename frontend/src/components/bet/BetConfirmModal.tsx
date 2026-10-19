'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BetSide } from '../../types';

export type BetSubmissionStep = 'idle' | 'awaiting_signature' | 'submitting' | 'confirmed';

interface BetConfirmModalProps {
  isOpen: boolean;
  fighter_a: string;
  fighter_b: string;
  side: BetSide;
  amount_xlm: number;
  /** Net payout after the platform fee is deducted. */
  estimated_payout_xlm: number;
  fee_bps: number;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** Optional external status override */
  status?: BetSubmissionStep;
}

const SIDE_LABEL: Record<BetSide, (a: string, b: string) => string> = {
  fighter_a: (a) => a,
  fighter_b: (_, b) => b,
  draw: () => 'Draw',
};

const STEP_LABELS: Record<BetSubmissionStep, string> = {
  idle: 'Confirm Bet',
  awaiting_signature: 'Awaiting wallet signature…',
  submitting: 'Submitting to Stellar…',
  confirmed: 'Confirmed!',
};

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function BetConfirmModal({
  isOpen,
  fighter_a,
  fighter_b,
  side,
  amount_xlm,
  estimated_payout_xlm,
  fee_bps,
  onConfirm,
  onCancel,
  status: externalStatus,
}: BetConfirmModalProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const feeHintId = useId();
  const [internalStatus, setInternalStatus] = useState<BetSubmissionStep>('idle');
  const isSubmittingRef = useRef(false);

  const currentStatus = externalStatus ?? internalStatus;
  const isInFlight = currentStatus !== 'idle';

  // Reset internal state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setInternalStatus('idle');
      isSubmittingRef.current = false;
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const onKey = (e: KeyboardEvent) => {
      // Prevent Escape modal dismissal while transaction is in flight
      if (e.key === 'Escape') {
        if (!isInFlight) {
          onCancel();
        }
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', onKey);
    const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    firstFocusable?.focus();

    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isInFlight, onCancel]);

  if (!isOpen) return <></>;

  const handleBackdropClick = () => {
    // Prevent modal dismissal via backdrop click while transaction is in flight
    if (!isInFlight) {
      onCancel();
    }
  };

  const handleConfirmClick = async () => {
    // Immediate double-submission prevention lock
    if (isSubmittingRef.current || isInFlight) return;
    isSubmittingRef.current = true;
    setInternalStatus('awaiting_signature');

    try {
      const result = onConfirm();
      if (result instanceof Promise) {
        setInternalStatus('submitting');
        await result;
        setInternalStatus('confirmed');
      }
    } catch (err) {
      isSubmittingRef.current = false;
      setInternalStatus('idle');
      throw err;
    }
  };

  const feeXlm = amount_xlm * (fee_bps / 10000);
  const feePct = fee_bps / 100;
  const netPayout = estimated_payout_xlm;
  const chosen = SIDE_LABEL[side](fighter_a, fighter_b);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
      aria-modal="true"
      role="dialog"
      aria-labelledby="bet-confirm-title"
    >
      <div
        ref={dialogRef}
        className="bg-gray-900 rounded-xl p-6 w-full max-w-sm mx-4 space-y-4 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="bet-confirm-title" className="text-lg font-bold">
          Confirm your bet
        </h2>

        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-gray-400">Fighter</dt>
            <dd>{chosen}</dd>
          </div>

          <div className="flex justify-between">
            <dt className="text-gray-400">You pay</dt>
            <dd>{amount_xlm.toFixed(4)} XLM</dd>
          </div>

          <div className="flex justify-between text-amber-400">
            <dt className="flex items-center gap-1">
              <span>Platform fee ({feePct.toFixed(2)}%)</span>
              <span
                className="inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold rounded-full border border-amber-400/60 cursor-help"
                title="A platform fee is deducted from your gross winnings when the market resolves. The net payout below already reflects this deduction."
                aria-label="Fee explanation"
              >
                i
              </span>
            </dt>
            <dd data-testid="fee-amount">{feeXlm.toFixed(4)} XLM</dd>
          </div>

          <div className="flex justify-between font-semibold border-t border-gray-800 pt-2">
            <dt className="text-gray-200">Net payout</dt>
            <dd data-testid="net-payout">{netPayout.toFixed(4)} XLM</dd>
          </div>
        </dl>

        <p id={feeHintId} className="text-xs text-gray-500">
          Net payout = gross winnings minus the platform fee. Actual amount depends on the final
          pool size at market close.
        </p>

        {isInFlight && (
          <div
            className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 p-2 rounded border border-amber-500/20"
            role="status"
          >
            <svg
              className="animate-spin h-4 w-4 text-amber-400"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v8H4z"
              />
            </svg>
            <span>{STEP_LABELS[currentStatus]}</span>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            onClick={onCancel}
            disabled={isInFlight}
            className="flex-1 min-h-[44px] rounded-lg border border-gray-600 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmClick}
            disabled={isInFlight}
            data-testid="confirm-bet-button"
            className="flex-1 min-h-[44px] rounded-lg bg-amber-500 hover:bg-amber-400 font-semibold text-black disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isInFlight ? (
              <>
                <svg
                  className="animate-spin h-4 w-4 text-black"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v8H4z"
                  />
                </svg>
                <span>Processing…</span>
              </>
            ) : (
              'Confirm Bet'
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}