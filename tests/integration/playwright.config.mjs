import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Real Worker + real local D1 + real cookies: no /api route is mocked. The
// harness starts inside the spec, so this config has no webServer.
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  timeout: 60000,
  workers: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync(systemChrome) ? systemChrome : undefined) },
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
});
