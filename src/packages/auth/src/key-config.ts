import { createPrivateKey, createPublicKey, KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface VerifierOptions {
  publicKey: KeyObject;
  issuer: string;
  audience: string;
}

export function readKey(
  env: NodeJS.ProcessEnv,
  name: 'JWT_PUBLIC_KEY' | 'JWT_PRIVATE_KEY',
): KeyObject {
  const inline = env[name],
    file = env[name + '_FILE'];

  if (Boolean(inline) === Boolean(file)) {
    throw new Error(name + ': configure exactly one PEM or file source');
  }

  try {
    const pem = inline || readFileSync(file!, 'utf8');
    const key = name === 'JWT_PRIVATE_KEY' ? createPrivateKey(pem) : createPublicKey(pem);

    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error();
    }

    return key;
  } catch {
    throw new Error(name + ': invalid RSA key or unreadable file (minimum 2048 bits)');
  }
}

export function verifierOptions(env: NodeJS.ProcessEnv): VerifierOptions {
  if (env.JWT_ISSUER !== 'ride-hailing' || env.JWT_AUDIENCE !== 'ride-api') {
    throw new Error('JWT_ISSUER/JWT_AUDIENCE must match the DS03 contract');
  }

  return {
    publicKey: readKey(env, 'JWT_PUBLIC_KEY'),
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  };
}

export function signingOptions(env: NodeJS.ProcessEnv) {
  const verifier = verifierOptions(env);
  const privateKey = readKey(env, 'JWT_PRIVATE_KEY');
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const supplied = verifier.publicKey.export({ type: 'spki', format: 'der' });

  if (!derived.equals(supplied)) {
    throw new Error('JWT RSA key pair does not match');
  }

  const ttl = Number(env.JWT_ACCESS_TTL_SECONDS ?? '3600');

  if (ttl !== 3600) {
    throw new Error('JWT_ACCESS_TTL_SECONDS must be 3600 for baseline v1');
  }

  return { ...verifier, privateKey, ttl };
}
