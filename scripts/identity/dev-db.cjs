const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

function compose(args) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      path.join(root, '.env'),
      '-f',
      path.join(root, 'deploy/identity-dev.compose.yml'),
      ...args,
    ],
    { cwd: root, stdio: 'inherit' },
  );

  if (result.error || result.status !== 0) {
    throw new Error('Identity Docker Compose command failed');
  }
}

(async () => {
  const action = process.argv[2] ?? 'up';

  if (action === 'up') {
    const running = spawnSync(
      'docker',
      [
        'ps',
        '-q',
        '--filter',
        'label=com.docker.compose.project=ds03-identity-dev',
        '--filter',
        'label=com.docker.compose.service=postgres',
      ],
      { encoding: 'utf8' },
    );

    if (running.status !== 0) {
      throw new Error('Docker Engine is unavailable; start Docker Desktop');
    }

    if (!running.stdout.trim()) {
      await new Promise((resolve, reject) => {
        const probe = net.createServer();

        probe.once('error', () =>
          reject(new Error('Port 5541 is occupied; no existing process was stopped')),
        );

        probe.listen(5541, '127.0.0.1', () => probe.close(resolve));
      });
    }

    compose(['up', '-d', '--wait', '--wait-timeout', '120']);
  } else if (action === 'stop') {
    compose(['stop', 'postgres']);
  } else if (action === 'start') {
    compose(['start', 'postgres']);
  } else {
    throw new Error('Expected up, stop or start; volumes are never deleted by this script');
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
