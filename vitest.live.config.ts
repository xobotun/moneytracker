import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { mergeConfig, defineConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Tests against real remote services (`*.live.spec.ts`), run with `npm run test:live`.
// Kept out of `test:unit` and CI: they need credentials and the network.
// Credentials come from the git-ignored `.env.test.local` (MT_* variables).
//
// Merged over vite.config, not vitest.config: mergeConfig concatenates arrays,
// so the unit config's `exclude` (which drops *.live.spec.ts) would carry over.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Node, not jsdom: jsdom installs its own AbortSignal, which Node's fetch
      // rejects — and every sync request carries a timeout signal.
      environment: 'node',
      include: ['src/**/*.live.spec.ts'],
      env: loadEnv('test', fileURLToPath(new URL('./', import.meta.url)), 'MT_'),
      testTimeout: 120_000,
      hookTimeout: 120_000,
      root: fileURLToPath(new URL('./', import.meta.url)),
      server: {
        deps: {
          inline: ['wa-sqlite'],
        },
      },
    },
  }),
)
