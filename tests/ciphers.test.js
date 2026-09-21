import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('seeded ciphers require decoding and preserve their advertised depth',()=>{
 const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 let seed=90210;const seededMath=Object.create(Math);seededMath.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const scope=vm.createContext({Buffer,console,Math:seededMath,GAMES:['sequence','cipher','logic','induction','automaton','walk','constraint']});
 vm.runInContext(source.slice(source.indexOf('const WORDS ='),source.indexOf('// ---------- daily tournament'))+';globalThis.ciphers=[makeCipher,makeCipherGM];',scope,{timeout:2000});
 const undo=(s,op)=>op==='base64'||op==='b64'?Buffer.from(s,'base64').toString():op==='hex'?Buffer.from(s,'hex').toString():op==='rot13'?s.replace(/[a-z]/gi,c=>String.fromCharCode((c.charCodeAt(0)-(c<='Z'?65:97)+13)%26+(c<='Z'?65:97))):[...s].reverse().join('');
 for(const [tier,gen] of scope.ciphers.entries())for(let i=0;i<500;i++){
  const p=gen();assert.notEqual(p.prompt,p.answer);
  const ops=tier?p.solution.summary.match(/order: (.*?) \(/)[1].split(' → '):[...p.layers].reverse();
  assert.ok(ops.length>=(tier?4:2)&&ops.length<=(tier?6:4));assert.equal(ops.reduce(undo,p.prompt),p.answer);
 }
});
