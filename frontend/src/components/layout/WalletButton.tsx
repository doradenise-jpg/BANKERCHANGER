// ============================================================
// BANKERCHANGER — WalletButton Component
// ============================================================

'use client';

import { useState, useRef, useEffect } from 'react';
import { useWallet } from '../../hooks/useWallet';
import { stellarExplorerUrl } from '../../services/wallet';

/** Freighter SVG logo mark (monochrome, 16 px) */
function FreighterIcon(): JSX.Element {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 32 32" fill="currentColor">
      <path d="M16 2L2 10v12l14 8 14-8V10L16 2zm0 3.2L27.2 11 16 16.8 4.8 11 16 5.2zM4 12.6l11 6.3v10.5L4 23V12.6zm13 16.8V18.9l11-6.3V23l-11 6.4z" />
    </svg>
  );
}

/** Albedo SVG logo mark (monochrome, 16 px) */
function AlbedoIcon(): JSX.Element {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 32 32" fill="currentColor">
      <circle cx="16" cy="16" r="12" fillOpacity="0.2" />
      <circle cx="16" cy="16" r="6" />
    </svg>
  );
}

export function WalletButton(): JSX.Element {
  const {
    address,
    balance,
    isConnected,
    isConnecting,
    connect,
    connectByType,
    disconnect,
    availableWallets,
  } = useWallet();
  const [open, setOpen] = useState(false);
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowWalletPicker(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setShowWalletPicker(false);
      }
    };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const bothInstalled = availableWallets.freighter && availableWallets.albedo;
  const freighterMissing = !availableWallets.freighter;

  function handleConnectClick() {
    if (freighterMissing || bothInstalled) {
      // Show modal to offer Freighter install or Albedo fallback
      setShowWalletPicker(true);
    } else {
      // Freighter is present and user clicked connect
      connect();
    }
  }

  if (!isConnected) {
    return (
      <div className="relative" ref={ref}>
        <button
          onClick={handleConnectClick}
          disabled={isConnecting}
          aria-label="Connect wallet"
          className="min-h-[44px] px-4 rounded-lg bg-amber-500 hover:bg-amber-400 font-semibold text-black text-sm disabled:opacity-50"
        >
          {isConnecting ? (
            <span className="flex items-center gap-2">
              <svg aria-hidden="true" className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Connecting…
            </span>
          ) : (
            'Connect Wallet'
          )}
        </button>

        {/*
         * Wallet selection modal (#360)
         * Shown when both Freighter and Albedo are installed.
         * Each button has a descriptive aria-label so screen readers
         * announce "Connect Freighter wallet" / "Connect Albedo wallet"
         * rather than just "button".
         */}
        {showWalletPicker && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Select a wallet to connect"
            className="absolute left-0 mt-2 w-72 bg-gray-900 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden"
          >
            {freighterMissing && (
              <div className="p-4 border-b border-gray-800 bg-gray-900/90">
                <p className="text-sm font-semibold text-white mb-1">
                  Install Freighter to use BANKERCHANGER
                </p>
                <p className="text-xs text-gray-400 mb-3">
                  Freighter is the recommended wallet extension for Stellar.
                </p>
                <a
                  href="https://freighter.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold rounded-lg"
                >
                  Install Freighter
                </a>
              </div>
            )}

            <div className="p-2">
              <p className="px-2 py-1 text-xs text-gray-400 font-medium uppercase tracking-wide">
                {freighterMissing ? 'Or connect with:' : 'Choose wallet'}
              </p>

              {availableWallets.freighter && (
                <button
                  aria-label="Connect Freighter wallet"
                  onClick={() => { setShowWalletPicker(false); connectByType('freighter'); }}
                  className="w-full min-h-[44px] px-3 text-left text-sm text-gray-200 hover:bg-gray-800 rounded-lg flex items-center gap-3"
                >
                  <FreighterIcon />
                  Freighter
                </button>
              )}

              <button
                aria-label="Connect Albedo wallet"
                onClick={() => { setShowWalletPicker(false); connectByType('albedo'); }}
                className="w-full min-h-[44px] px-3 text-left text-sm text-gray-200 hover:bg-gray-800 rounded-lg flex items-center gap-3"
              >
                <AlbedoIcon />
                Albedo
              </button>
            </div>

            <button
              aria-label="Cancel wallet selection"
              onClick={() => setShowWalletPicker(false)}
              className="w-full min-h-[40px] px-4 text-center text-xs text-gray-500 hover:bg-gray-800 border-t border-gray-800"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  }

  const short = address ? `${address.slice(0, 4)}…${address.slice(-4)}` : '';

  const handleCopy = async () => {
    await navigator.clipboard.writeText(address ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Wallet menu for ${address ?? 'connected wallet'}`}
        aria-expanded={open}
        aria-haspopup="menu"
        className="min-h-[44px] px-3 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-white flex items-center gap-2"
      >
        <span className="font-mono">{short}</span>
        {balance != null && <span className="text-gray-400 text-xs">{balance.toFixed(2)} XLM</span>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 w-48 bg-gray-900 border border-gray-700 rounded-lg shadow-lg z-50 overflow-hidden">
          <button
            role="menuitem"
            onClick={handleCopy}
            className="w-full min-h-[44px] px-4 text-left text-sm text-gray-300 hover:bg-gray-800"
          >
            {copied ? 'Copied!' : 'Copy Address'}
          </button>
          <a
            role="menuitem"
            href={stellarExplorerUrl('account', address ?? '')}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="flex items-center min-h-[44px] px-4 text-sm text-gray-300 hover:bg-gray-800"
          >
            View on Explorer
          </a>
          <button
            role="menuitem"
            onClick={() => { disconnect(); setOpen(false); }}
            className="w-full min-h-[44px] px-4 text-left text-sm text-red-400 hover:bg-gray-800"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
