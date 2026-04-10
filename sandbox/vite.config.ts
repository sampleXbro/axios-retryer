import type { UserConfig } from 'vite';
import { defineConfig } from 'vite';

/**
 * Default `/` keeps standalone `pnpm dev` in this folder ergonomic.
 * Website embed sets `SANDBOX_VITE_BASE` to match `website/site-base.mjs` + `sandbox/`.
 */
function sandboxBase(): string {
  const fromEnv = process.env.SANDBOX_VITE_BASE;
  if (fromEnv !== undefined && fromEnv !== '') {
    const b = fromEnv.endsWith('/') ? fromEnv : `${fromEnv}/`;
    return b;
  }
  return '/';
}

export default defineConfig(
  (): UserConfig => ({
    base: sandboxBase(),
  }),
);
