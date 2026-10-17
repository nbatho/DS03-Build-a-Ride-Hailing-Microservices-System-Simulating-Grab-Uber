const fs = require('node:fs');
const path = require('node:path');
const { createEnvironment } = require('../../tests/helpers/identity-environment.cjs');
const { projects } = require('../../nest-cli.json');
const { SERVICE_PORT_ENV } = require('./service-ports.cjs');

async function main() {
  const output = process.argv[2];

  if (!output) {
    throw new Error('Usage: node scripts/dev/dump-openapi.cjs <output-dir>');
  }

  fs.mkdirSync(output, { recursive: true });

  const cleanups = [];
  const lifecycle = { after: callback => cleanups.unshift(callback) };

  try {
    const fixture = await createEnvironment(lifecycle);
    const apps = Object.entries(projects).filter(([, project]) => project.type === 'application');

    for (const [name] of apps) {
      const app = await fixture.launch(name, SERVICE_PORT_ENV[name]);
      const response = await fetch(app.url + '/docs-json');
      const document = await response.json();

      fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(document, null, 2) + '\n');
      console.log('Saved ' + name);
    }
  } finally {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
