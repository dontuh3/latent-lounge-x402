import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// File-backed stdio also works in Windows environments that disallow child pipes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'latent-gate-'));
let serial = 0, failures = 0;
function run(command, args, { input = '', env = process.env, timeout = 90000 } = {}) {
  const prefix = path.join(scratch, String(serial++));
  fs.writeFileSync(prefix + '.in', input);
  const fds = [fs.openSync(prefix + '.in','r'), fs.openSync(prefix + '.out','w'), fs.openSync(prefix + '.err','w')];
  let result;
  try { result = spawnSync(command, args, { cwd: root, env, stdio: fds, timeout }); }
  finally { fds.forEach(fd => fs.closeSync(fd)); }
  return { status: result.status, out: fs.readFileSync(prefix + '.out','utf8'), err: fs.readFileSync(prefix + '.err','utf8'), error: result.error };
}
function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}
function success(result) { if (result.status !== 0) throw new Error(result.error?.message || result.err || result.out || `Exit ${result.status}`); return result.out; }
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  const inventory = run('git',['ls-files','--cached','--others','--exclude-standard']);
  const files = [...new Set(success(inventory).trim().split(/\r?\n/))].filter(Boolean);
  check('source syntax', () => { for (const file of files.filter(f => /\.(js|mjs)$/.test(f))) success(run(process.execPath,['--check',file])); });
  check('tracked-source secret scan', () => {
    const hits = files.filter(file => {
      if (file === '.env') return true;
      if (file === 'package-lock.json' || !/\.(js|mjs|json|md|txt|ya?ml|html|sh)$/.test(file)) return false;
      const text = fs.readFileSync(path.join(root,file),'utf8');
      return /BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY/.test(text) || /0x[a-fA-F0-9]{64}\b/.test(text);
    });
    if (hits.length) throw new Error(`Review possible secrets in: ${hits.join(', ')} (values omitted)`);
  });
  check('regression suite and real local protocol checks', () => {
    const tests = files.filter(f => /^tests\/.*\.test\.js$/.test(f));
    if (!tests.length) throw new Error('No tests found.');
    const flags = Number(process.versions.node.split('.')[0]) >= 22 ? ['--test-isolation=none'] : [];
    const result = run(process.execPath,['--test',...flags,...tests]);
    console.log(success(result).trim());
  });
  if (pkg.name === 'latent-lounge-x402') check('generator invariants', () => {
    const env = { PATH:process.env.PATH, SystemRoot:process.env.SystemRoot, PAY_TO_ADDRESS:'0x'+'0'.repeat(40), NETWORK:'base-sepolia', DATA_DIR:path.join(scratch,'selftest') };
    console.log(success(run(process.execPath,['server.js','--selftest'],{env})).trim());
  });
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
  check('fresh dependency audit', () => {
    const audit = run(process.execPath,[npmCli,'audit','--omit=dev','--json','--offline=false','--fetch-retries=0','--fetch-timeout=15000','--cache',path.join(scratch,'npm-cache')],{timeout:30000});
    // npm audit returns nonzero for findings; the policy checker distinguishes them from unavailable results.
    console.log(success(run(process.execPath,['scripts/check-audit.js'],{input:audit.out})).trim());
  });
  if (pkg.name === 'latent-lounge-mcp') check('publish contents', () => {
    const packed = JSON.parse(success(run(process.execPath,[npmCli,'pack','--dry-run','--json','--ignore-scripts','--cache',path.join(scratch,'npm-cache')])));
    const files = packed[0].files.map(f => f.path);
    const allowed = new Set(['LICENSE','README.md','package.json','index.js','budget.js']);
    if (!files.includes('index.js') || !files.includes('budget.js') || files.some(f => !allowed.has(f))) throw new Error(`Unexpected package contents: ${files.join(', ')}`);
  });
} catch (error) { failures++; console.error(error.message); }
finally {
  // Remove only this gate's verified, freshly allocated temporary directory.
  const target = fs.realpathSync(scratch), parent = fs.realpathSync(os.tmpdir());
  if (path.dirname(target) === parent && path.basename(target).startsWith('latent-gate-')) fs.rmSync(target,{recursive:true,force:true});
}
console.log(failures ? 'GATE FAILED — do not release.' : 'GATE PASSED — configured checks passed.');
process.exitCode = failures ? 1 : 0;
