const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { projects } = require('../../nest-cli.json');

const root = path.resolve(__dirname, '../..');
const cli = require.resolve('@nestjs/cli/bin/nest.js');
for (const [name, project] of Object.entries(projects)) {
  if (project.type !== 'application') continue;
  console.log('Building ' + name);
  const result = spawnSync(process.execPath, [cli, 'build', name], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
