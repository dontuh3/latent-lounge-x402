import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeEventTopics,encodeAbiParameters,parseAbi} from 'viem';
import {verifyRecovery} from '../payment-recovery.js';
const from='0x'+'a'.repeat(40),to='0x'+'b'.repeat(40),asset='0x'+'c'.repeat(40),nonce='0x'+'d'.repeat(64),tx='0x'+'e'.repeat(64);
const abi=parseAbi(['event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)','event Transfer(address indexed from, address indexed to, uint256 value)']);
const record={payload:{network:'base',payload:{authorization:{from,nonce,validBefore:'100'}}},requirements:{asset,payTo:to,maxAmountRequired:'20000'}};
function client({used=false,chain=8453,wrongAmount=false,wrongNonce=false,finalized=2n}={}){
 return {getChainId:async()=>chain,getBlock:async()=>({number:finalized,timestamp:200n}),readContract:async()=>used,getTransactionReceipt:async()=>({status:'success',blockNumber:2n,logs:[{address:asset,topics:encodeEventTopics({abi,eventName:'AuthorizationUsed',args:{authorizer:from,nonce:wrongNonce?'0x'+'f'.repeat(64):nonce}}),data:'0x'},{address:asset,topics:encodeEventTopics({abi,eventName:'Transfer',args:{from,to}}),data:encodeAbiParameters([{type:'uint256'}],[wrongAmount?1n:20000n])}]})};
}
test('recovery requires matching finalized token transfer and authorization on the correct chain',async()=>{
 assert.ok((await verifyRecovery(record,{transactionHash:tx},'',client())).receipt);
 for(const options of [{chain:1},{wrongAmount:true},{wrongNonce:true},{finalized:1n}])await assert.rejects(verifyRecovery(record,{transactionHash:tx},'',client(options)));
});
test('uncertain purchase may be released only after expiry and with an unused nonce',async()=>{
 assert.deepEqual(await verifyRecovery(record,{action:'release-expired'},'',client()),{cancelled:true});
 await assert.rejects(verifyRecovery(record,{action:'release-expired'},'',client({used:true})));
 await assert.rejects(verifyRecovery({...record,payload:{...record.payload,payload:{authorization:{from,nonce,validBefore:'300'}}}},{action:'release-expired'},'',client()));
});
