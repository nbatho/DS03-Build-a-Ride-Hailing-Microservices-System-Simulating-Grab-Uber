const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const operation = process.argv[2] ?? 'run';

if (!['run', 'show', 'revert'].includes(operation)) {
  throw new Error('Invalid migration operation');
}

const compiled = process.argv.includes('--compiled');
const dataSource = compiled
  ? path.join(root, 'dist/identity-migrations/src/database/data-source.js')
  : path.join(root, 'src/services/identity-user-service/src/database/data-source.ts');
const args = compiled ? [] : ['-r', 'ts-node/register'];

args.push(require.resolve('typeorm/cli.js'), 'migration:' + operation, '-d', dataSource);
const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
});

if (result.error) {
  throw new Error('Unable to start migration runner');
}

process.exitCode = result.status ?? 1;
