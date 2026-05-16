import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './apps/e2e',
  timeout: 90_000,          // transcode + buffer can take >30s for HDR
  expect: { timeout: 60_000 },
  fullyParallel: false,     // single FFmpeg box — run tests serially
  retries: 0,
  reporter: 'list',

  use: {
    baseURL: 'http://localhost:5173',
    ...devices['Desktop Chrome'],
    // capture failed-test artifacts
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },

  // Start Vite dev server before tests; assume backend already running on :7777.
  // If you want the test to start the backend too, uncomment the second entry.
  webServer: {
    command: 'npm -w @horizon/web run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
