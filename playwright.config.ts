import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import os from 'node:os'

// Shared with apps/e2e/global-setup.ts. Kept in sync by mirroring the same
// tmpdir layout (config can't import runtime values from setup cleanly across
// the Playwright boundary, so the literal paths are duplicated here).
const E2E_DIR = path.join(os.tmpdir(), 'horizon-e2e')
const E2E_DB = path.join(E2E_DIR, 'horizon.db')
const E2E_CACHE = path.join(E2E_DIR, 'cache')

export default defineConfig({
  testDir: './apps/e2e',
  timeout: 90_000,          // transcode + buffer can take >30s for HDR
  expect: { timeout: 60_000 },
  fullyParallel: false,     // single FFmpeg box — run tests serially
  retries: 0,
  reporter: 'list',

  // Wipe the e2e DB before the run so the first-boot wizard sees an empty household.
  globalSetup: './apps/e2e/global-setup.ts',

  use: {
    baseURL: 'http://localhost:5173',
    ...devices['Desktop Chrome'],
    // capture failed-test artifacts
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },

  // Deterministic ordering via project dependency: the first-boot wizard MUST
  // run against the freshly-wiped empty DB, so it's its own `setup` project that
  // everything else depends on. The `main` project then runs with the owner that
  // setup created (its specs use the auth helper, which logs in as that owner).
  projects: [
    { name: 'setup', testMatch: /00-setup\.spec\.ts/ },
    {
      name: 'main',
      testIgnore: /00-setup\.spec\.ts/,
      dependencies: ['setup'],
    },
  ],

  // Start BOTH the backend (own e2e DB + media base, no dev DB wipe) and Vite.
  // The backend owns :7777; Vite proxies /auth, /users, /library, /settings… to it.
  webServer: [
    {
      command: 'node --import tsx apps/server/src/index.ts',
      url: 'http://localhost:7777/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'development',
        HORIZON_PORT: '7777',
        HORIZON_DB_PATH: E2E_DB,
        HORIZON_CACHE_DIR: E2E_CACHE,
        // Serve API only; Vite serves the UI in dev.
        HORIZON_SERVE_WEB: '0',
        // Deterministic library fixtures for the scenario/authz specs.
        HORIZON_DEV_SEED: '1',
        // Relax security throttles for the test run (many seeds + logins from one
        // IP). These are dev-only overrides; production keeps the strict defaults.
        HORIZON_DEV_SEED_MAX_PER_WINDOW: '1000',
        HORIZON_LOGIN_IP_MAX: '1000',
      },
    },
    {
      command: 'npm -w @horizon/web run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
