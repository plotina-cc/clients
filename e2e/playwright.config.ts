import { defineConfig, devices } from "@playwright/test";

// Optional local .env (gitignored). In CI the values come from the environment.
try {
  process.loadEnvFile(new URL(".env", import.meta.url).pathname);
} catch {
  /* no .env file — fine */
}

const baseURL = process.env.E2E_BASE_URL ?? "https://call.plotina.cc";

export default defineConfig({
  testDir: "./tests",
  // The call test waits up to 60 s for the processor and a few seconds for
  // the lobby, so the per-test budget has to be larger than either.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  // One joined call at a time: two browsers publishing into the same room
  // make the attach event harder to attribute.
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Playwright records video through its own ffmpeg build, a separate
    // download; the trace already carries DOM snapshots and screenshots.
    video: "off",
    screenshot: "only-on-failure",
    launchOptions: {
      args: [
        // Chromium's built-in fake microphone, so no real device is needed.
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        // AudioContext must start without a user gesture: the effect test
        // drives WebAudio from page.evaluate.
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
