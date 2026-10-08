// ESM half of wallet-ui-tripwire.cjs.
import fs from 'node:fs';
const pattern = /[\\/]node_modules[\\/](wagmi|@wagmi|@walletconnect|query-string|decode-uri-component)[\\/]/;
export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (process.env.TRIPWIRE_FILE && pattern.test(result.url)) fs.appendFileSync(process.env.TRIPWIRE_FILE, `import ${result.url}\n`);
  return result;
}
