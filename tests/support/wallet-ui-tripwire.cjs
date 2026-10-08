// Test-only tripwire: records any load of the browser wallet-UI dependency tree (wagmi,
// WalletConnect, query-string, decode-uri-component). The server must never load it; see
// the decode-uri-component exception in .audit-allowlist.json.
const fs = require('fs');
const Module = require('module');
const pattern = /[\\/]node_modules[\\/](wagmi|@wagmi|@walletconnect|query-string|decode-uri-component)[\\/]/;
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  const file = resolve.call(this, request, parent, ...rest);
  if (process.env.TRIPWIRE_FILE && pattern.test(file)) fs.appendFileSync(process.env.TRIPWIRE_FILE, `require ${file}\n`);
  return file;
};
