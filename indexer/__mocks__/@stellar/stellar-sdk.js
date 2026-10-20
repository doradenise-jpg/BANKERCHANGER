// Manual Jest mock for @stellar/stellar-sdk.
//
// The published package ships ESM-only @noble/hashes deep imports which Jest's
// default CommonJS runtime cannot parse (see jest transformIgnorePatterns).
// The indexer unit tests never exercise real RPC/XDR behaviour, so a thin
// in-memory stand-in keeps the suite runnable without transforming node_modules.

class Server {
  constructor(url) {
    this.url = url;
  }

  async getEvents() {
    return { events: [] };
  }

  async getLatestLedger() {
    return { sequence: 0 };
  }

  async getLedgers() {
    return { ledgers: [], latestLedger: 0 };
  }

  async getLedger() {
    return { sequence: 0 };
  }
}

class Contract {
  constructor() {}
}

class Address {}

module.exports = {
  rpc: { Server, Api: {} },
  Contract,
  Address,
  scValToNative: (value) => value,
  nativeToScVal: (value) => value,
  xdr: {},
  Keypair: {
    random: () => ({
      publicKey: () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      secret: () => 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }),
    fromPublicKey: (key) => ({ publicKey: () => key }),
  },
};
