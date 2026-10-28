import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
      // .claude/worktrees: other branches checked out by agents, not this one's tests.
      exclude: [...configDefaults.exclude, 'e2e/**', '**/*.live.spec.ts', '.claude/worktrees/**'],
      root: fileURLToPath(new URL('./', import.meta.url)),
      server: {
        deps: {
          inline: ['wa-sqlite'],
        },
      },
    },
  }),
)
