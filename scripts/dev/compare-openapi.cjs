const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const [baseline, current] = process.argv.slice(2);

if (!baseline || !current) {
  console.error('Usage: node scripts/dev/compare-openapi.cjs <baseline-dir> <current-dir>');
  process.exit(1);
}

let failures = 0;

for (const file of fs.readdirSync(baseline).filter(name => name.endsWith('.json'))) {
  const expected = JSON.parse(fs.readFileSync(path.join(baseline, file), 'utf8'));
  const target = path.join(current, file);

  if (!fs.existsSync(target)) {
    console.error('MISSING ' + file);
    failures += 1;
    continue;
  }

  try {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), expected);
    console.log('SAME    ' + file);
  } catch (error) {
    console.error('DIFF    ' + file + '\n' + error.message.slice(0, 4000));
    failures += 1;
  }
}

process.exitCode = failures ? 1 : 0;
