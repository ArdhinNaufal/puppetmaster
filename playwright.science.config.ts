import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const root = resolve(process.cwd());
const runId = process.env.SCIENCE_E2E_RUN_ID?.trim() ||
  new Date().toISOString().replace(/[:.]/g, "-");
process.env.SCIENCE_E2E_RUN_ID = runId;

function boundedPort(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1024 through 65535.`);
  }
  return value;
}

function installedChromium(): string {
  const configured = process.env.SCIENCE_E2E_BROWSER_PATH?.trim();
  const candidates = [
    configured,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error(
      "Science browser evidence requires an installed Chrome, Edge, or Chromium. " +
        "Set SCIENCE_E2E_BROWSER_PATH to its executable; this harness never downloads a browser.",
    );
  }
  return executable;
}

const apiPort = boundedPort("SCIENCE_E2E_API_PORT", 4_100);
const webPort = boundedPort("SCIENCE_E2E_WEB_PORT", 3_100);
if (apiPort === webPort) throw new Error("Science E2E API and web ports must differ.");

const apiBase = `http://127.0.0.1:${apiPort}`;
const webBase = `http://127.0.0.1:${webPort}`;
const runtimeRoot = resolve(root, "test-results", "science-runtime", runId);
mkdirSync(runtimeRoot, { recursive: true });

export default defineConfig({
  testDir: "./tests/science-e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  outputDir: "test-results/science",
  reporter: [
    ["line"],
    ["html", { outputFolder: "playwright-report/science", open: "never" }],
  ],
  use: {
    baseURL: webBase,
    browserName: "chromium",
    headless: process.env.SCIENCE_E2E_HEADED !== "1",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    launchOptions: { executablePath: installedChromium() },
    trace: "on",
    screenshot: "only-on-failure",
    // Video needs Playwright's separately downloaded ffmpeg bundle. Traces and
    // explicit screenshots remain retained without introducing that download.
    video: "off",
  },
  webServer: [
    {
      command: "pnpm --filter @puppetmaster/server start",
      cwd: root,
      url: `${apiBase}/api/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: "development",
        HOST: "127.0.0.1",
        PORT: String(apiPort),
        PGLITE_DATA_DIR: resolve(runtimeRoot, "pglite"),
        SCIENCE_ENABLED: "1",
        SCIENCE_READ_ONLY: "0",
        SCIENCE_POLL_INTERVAL_MS: "100",
        SCIENCE_FIXTURE_PROVISIONING_MS: "25",
        SCIENCE_FIXTURE_RUNNING_MS: "50",
        SCIENCE_SIGNING_SECRET: "science-browser-release-evidence-only",
        SCIENCE_ARTIFACT_ROOT: resolve(runtimeRoot, "artifacts"),
        SCIENCE_QUARANTINE_ROOT: resolve(runtimeRoot, "quarantine"),
      },
    },
    {
      command: `pnpm --filter @puppetmaster/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
      cwd: root,
      url: webBase,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        PUPPETMASTER_API_TARGET: apiBase,
      },
    },
  ],
});
