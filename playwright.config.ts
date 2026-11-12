import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...devices['Desktop Chrome'] },
  webServer: { command: 'npm run build && npm start', url: `http://127.0.0.1:${PORT}/api/health`, env: { PORT: String(PORT) }, reuseExistingServer: false, timeout: 60_000 },
});
