import { defineConfig } from '@playwright/test';

const mode = process.env.RL_MODE ?? 'fixed';
const port = Number(process.env.PORT ?? (mode === 'faulty' ? 4011 : 4010));

export default defineConfig({
  testDir: './tests',
  // One in-memory service; tests reset it, so run them one at a time.
  workers: 1,
  fullyParallel: false,
  reporter: [
    ['list'],
    ['json', { outputFile: `results/${mode}/results.json` }],
    ['html', { outputFolder: `results/${mode}/html-report`, open: 'never' }],
  ],
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: 'npx tsx src/server.ts',
    url: `http://localhost:${port}/health`,
    env: { RL_MODE: mode, PORT: String(port) },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
