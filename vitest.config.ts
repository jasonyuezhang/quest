import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    exclude: ['.quest-workers/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'src/state/**/*.ts',
        'src/sprint/**/*.ts',
        'src/context/**/*.ts',
        'src/events.ts',
        'src/orchestrator.ts',
        'src/scaffold.ts',
        'src/agents/coder.ts',
        'src/failure-classifier.ts',
      ],
    },
  },
})
