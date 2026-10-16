const { generateKeyPairSync, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function generateKeys(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const privateFile = path.join(directory, 'identity-private.pem');
  const publicFile = path.join(directory, 'identity-public.pem');

  if (fs.existsSync(privateFile) || fs.existsSync(publicFile)) {
    throw new Error('RSA key already exists; refusing to overwrite');
  }

  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  fs.writeFileSync(privateFile, pair.privateKey, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(publicFile, pair.publicKey, { flag: 'wx', mode: 0o644 });

  return createHash('sha256').update(pair.publicKey).digest('hex');
}

module.exports = { generateKeys };
if (require.main === module) {
  try {
    const directory = path.resolve(__dirname, '../../deploy/secrets');

    console.log('RSA public-key SHA-256:', generateKeys(directory));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
