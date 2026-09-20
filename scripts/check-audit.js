import fs from 'node:fs';
// Input is npm audit --json. Package-wide exceptions deliberately do not count.
try {
  const audit = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (audit.error || !audit.vulnerabilities || !audit.metadata) throw new Error('Audit unavailable or malformed.');
  const policy = JSON.parse(fs.readFileSync('.audit-allowlist.json', 'utf8'));
  const exceptions = policy.advisories || [];
  const failures = [];
  for (const [name, info] of Object.entries(audit.vulnerabilities)) {
    if (info.severity === 'critical') failures.push(`${name}: critical vulnerability`);
    for (const advisory of info.via.filter(v => typeof v === 'object')) {
      const versions = [...new Set(info.nodes.map(node => JSON.parse(fs.readFileSync(`${node}/package.json`, 'utf8')).version))];
      const accepted = exceptions.find(e => e.package === name && e.url === advisory.url && e.severity === advisory.severity
        && e.reason && /^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy) && e.reviewBy >= new Date().toISOString().slice(0, 10)
        && versions.every(v => e.versions?.includes(v)));
      if (!accepted) failures.push(`${name}@${versions.join(',')}: ${advisory.url} (${advisory.severity}) needs review`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log('Audit passed: no unreviewed direct advisories or critical dependency findings.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
