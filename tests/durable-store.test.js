import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DurableStore} from '../durable-store.js';

test('a crash between ledger replacements replays the committed transaction exactly once',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lounge-durable-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new DurableStore(dir);const original=store.atomic.bind(store);
 store.atomic=(file,value)=>{if(path.basename(file)==='second.json')throw Error('simulated crash');return original(file,value);};
 assert.throws(()=>store.transaction(()=>{store.write(path.join(dir,'first.json'),{plays:1});store.write(path.join(dir,'second.json'),{consumed:true});}));
 assert.equal(store.pending().state,'confirmed');
 const restarted=new DurableStore(dir);
 assert.deepEqual(restarted.read(path.join(dir,'first.json'),{}),{plays:1});
 assert.deepEqual(restarted.read(path.join(dir,'second.json'),{}),{consumed:true});
 assert.deepEqual(restarted.pending(),{});
 new DurableStore(dir);assert.deepEqual(restarted.read(path.join(dir,'first.json'),{}),{plays:1});
});
