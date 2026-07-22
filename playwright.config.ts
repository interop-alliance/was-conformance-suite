import { defineConfig, devices } from '@playwright/test'

/**
 * A dedicated port (overridable via PW_DEV_PORT), NOT vite's default 5173:
 * `reuseExistingServer` reuses whatever answers on the port, so running on the
 * shared vite default risks silently testing against some other project's dev
 * server. `--strictPort` makes a collision fail loudly instead of drifting to
 * another port the config is not watching.
 */
const port = Number(process.env.PW_DEV_PORT ?? 5187)

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}/test/index.html`,
    reuseExistingServer: !process.env.CI
  }
})
