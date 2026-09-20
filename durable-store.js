import fs from 'node:fs';
import path from 'node:path';

// Single-process write-ahead journal. Recovery replays absolute ledger values,
// so a crash between file replacements cannot award a result twice.
export class DurableStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.journal = path.join(this.root, 'transaction-journal.json');
    this.staged = null;
    this.recover();
  }
  atomic(file, value) {
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  }
  filename(name) {
    if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error('Invalid ledger name');
    return path.join(this.root, name);
  }
  read(file, empty) {
    const name = path.basename(file);
    if (this.staged?.has(name)) return structuredClone(this.staged.get(name));
    try {
      const value = JSON.parse(fs.readFileSync(file,'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) !== Array.isArray(empty)) throw new Error('Invalid ledger');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return structuredClone(empty); throw error; }
  }
  write(file, value) {
    if (this.staged) this.staged.set(path.basename(file), structuredClone(value));
    else this.atomic(file,value);
  }
  capture(fn) {
    if (this.staged) throw new Error('Nested ledger transaction');
    this.staged = new Map();
    try { const result=fn(); return {result, entries:Object.fromEntries(this.staged)}; }
    finally { this.staged=null; }
  }
  pending() { return this.read(this.journal, {}); }
  prepare(record) {
    if (Object.keys(this.pending()).length) throw new Error('Recovery required');
    this.atomic(this.journal, {...record,state:'prepared'});
  }
  commit(record) {
    this.atomic(this.journal,{...record,state:'confirmed'});
    this.recover();
  }
  recover() {
    const record=this.pending();
    if(record.state !== 'confirmed') return;
    for (const [name,value] of Object.entries(record.entries)) this.atomic(this.filename(name),value);
    this.atomic(this.journal,{});
  }
  abort() { this.atomic(this.journal,{}); }
  transaction(fn) {
    if (Object.keys(this.pending()).length) throw new Error('Recovery required');
    const {result,entries}=this.capture(fn);
    this.commit({kind:'local',entries}); return result;
  }
}
