export { AuthVerifierModule } from './auth-verifier.module';
export { JwtAuthGuard, RolesGuard, JWT_VERIFIER_OPTIONS } from './guards';
export { Public, Roles, CurrentUser } from './decorators';
export { readKey, verifierOptions, signingOptions } from './key-config';
export type { VerifierOptions } from './key-config';
