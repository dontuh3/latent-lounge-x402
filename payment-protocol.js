import { isDeepStrictEqual } from 'node:util';

export const legacyNetwork = n => ({'eip155:8453':'base','eip155:84532':'base-sepolia'}[n] || n);
export function v2Requirement(v1) {
  const network = {base:'eip155:8453','base-sepolia':'eip155:84532'}[v1.network];
  if (!network) throw new Error('Unsupported v2 network');
  return {scheme:v1.scheme,network,amount:v1.maxAmountRequired,asset:v1.asset,payTo:v1.payTo,maxTimeoutSeconds:v1.maxTimeoutSeconds,extra:v1.extra};
}
export function readPayment(req) {
  const modern=req.header('PAYMENT-SIGNATURE'), legacy=req.header('X-PAYMENT');
  if (modern && legacy) throw new Error('Use only one payment header');
  const raw=modern || legacy;
  if (!raw) return null;
  if (raw.length>12000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('Malformed payment header');
  const value=JSON.parse(Buffer.from(raw,'base64').toString('utf8'));
  if(value.x402Version !== (modern?2:1)) throw new Error('Payment header version mismatch');
  return value;
}
export function matchesV2(payload, requirement) {
  return payload?.x402Version===2 && isDeepStrictEqual(payload.accepted,requirement);
}
export function receiptHeaders(res, receipt) {
  // Same settlement, both transport names. Normalize only the network spelling.
  const value=JSON.parse(Buffer.from(receipt,'base64').toString('utf8'));
  const old={...value,network:legacyNetwork(value.network)};
  const modern={...value,network:{base:'eip155:8453','base-sepolia':'eip155:84532'}[old.network] || value.network};
  res.setHeader('X-PAYMENT-RESPONSE',Buffer.from(JSON.stringify(old)).toString('base64'));
  res.setHeader('PAYMENT-RESPONSE',Buffer.from(JSON.stringify(modern)).toString('base64'));
}
