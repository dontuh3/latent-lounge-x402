import {createPublicClient,http,parseAbi,decodeEventLog} from 'viem';
const abi=parseAbi([
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)'
]);
export async function verifyRecovery(record,input,rpcUrl,client=createPublicClient({transport:http(rpcUrl,{timeout:15000,retryCount:0})})) {
  const network=record.payload.accepted?.network || record.payload.network;
  const expectedChain=['base','eip155:8453'].includes(network) ? 8453 : ['base-sepolia','eip155:84532'].includes(network) ? 84532 : null;
  if(!expectedChain || await client.getChainId()!==expectedChain) throw new Error('Recovery RPC network does not match payment.');
  const auth=record.payload.payload.authorization;
  const asset=record.requirements.asset.toLowerCase();
  if(input.action==='release-expired') {
    const block=await client.getBlock({blockTag:'finalized'});
    if(block.timestamp<=BigInt(auth.validBefore)) throw new Error('Authorization has not expired at finality.');
    const used=await client.readContract({address:asset,abi,functionName:'authorizationState',args:[auth.from,auth.nonce],blockNumber:block.number});
    if(used) throw new Error('Authorization was used. Supply its transaction hash instead.');
    return {cancelled:true};
  }
  if(!/^0x[a-fA-F0-9]{64}$/.test(input.transactionHash || '')) throw new Error('Provide a transactionHash or action release-expired.');
  const receipt=await client.getTransactionReceipt({hash:input.transactionHash});
  const finalized=await client.getBlock({blockTag:'finalized'});
  if(receipt.status!=='success' || receipt.blockNumber>finalized.number) throw new Error('Transaction is not successful and finalized.');
  let authorization=false, transfer=false;
  for(const log of receipt.logs.filter(log=>log.address.toLowerCase()===asset)) {
    try {
      const event=decodeEventLog({abi,data:log.data,topics:log.topics});
      if(event.eventName==='AuthorizationUsed' && event.args.authorizer.toLowerCase()===auth.from.toLowerCase() && event.args.nonce.toLowerCase()===auth.nonce.toLowerCase()) authorization=true;
      if(event.eventName==='Transfer' && event.args.from.toLowerCase()===auth.from.toLowerCase() && event.args.to.toLowerCase()===record.requirements.payTo.toLowerCase() && event.args.value===BigInt(record.requirements.amount || record.requirements.maxAmountRequired)) transfer=true;
    } catch { /* unrelated token event */ }
  }
  if(!authorization || !transfer) throw new Error('Transaction does not prove this payment.');
  return {receipt:Buffer.from(JSON.stringify({success:true,transaction:input.transactionHash,network,payer:auth.from})).toString('base64')};
}
