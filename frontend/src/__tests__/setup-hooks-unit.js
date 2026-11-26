/**
 * Setup file for hooks-unit tests with jsdom environment
 * Provides polyfills that stellar-sdk requires
 */

// Polyfill TextEncoder/TextDecoder for stellar-sdk
if (typeof global.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util');
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
}

// Polyfill crypto for stellar-sdk if needed
if (typeof global.crypto === 'undefined') {
  global.crypto = require('crypto').webcrypto || {};
}
