const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

function testEvidence(name, description) {
  const started = Date.now();
  const evidence = {
    test: name,
    ...description,
    actual: [],
    dbBefore: undefined,
    dbAfter: undefined,
    summary: undefined,
    error: undefined,
  };

  return {
    record: item => evidence.actual.push(item),
    set: fields => Object.assign(evidence, fields),
    get: field => evidence[field],
    fail: error => {
      evidence.error = error.message;
    },
    write() {
      const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
      const directory = path.join(root, 'docs/test-evidence/trip');

      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, name + '.json'),
        JSON.stringify(
          {
            ...evidence,
            status: evidence.error || evidence.actual.length === 0 ? 'FAIL' : 'PASS',
            commit: commit.stdout.trim() || 'unknown',
            executedAt: new Date().toISOString(),
            durationMs: Date.now() - started,
            tokens: '[REDACTED]',
          },
          null,
          2,
        ) + '\n',
      );
    },
  };
}

module.exports = { testEvidence };
