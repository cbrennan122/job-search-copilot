import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

// Browser tests for the dashboard. These cover the one thing the node:test suite
// structurally cannot: whether the pages actually render. The bug that motivated
// them shipped green through typecheck, lint and 165 unit tests — the queue sat
// on "Loading…" forever because a debounce timer flipped the flag back on and no
// effect dependency changed to clear it. Nothing but a real browser sees that.

const PORT = 3100;
const DB = path.join(process.cwd(), "tests", "ui", ".tmp", "fixture.db");

export default defineConfig({
  testDir: "./tests/ui",
  // Two runners now share the tests/ tree, so the split has to be airtight in
  // BOTH directions: node:test globs `tests/unit/*.test.ts` and
  // `tests/integration/*.test.ts` by explicit directory and never sees these,
  // and `testDir` + a `.spec.ts` match keeps Playwright out of those. It also
  // keeps Playwright off seed.ts and pages/*.page.ts, which are helpers, not
  // specs — a page object picked up as a test file is an empty suite that
  // silently reports success.
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // Seed FIRST, in the same command, so ordering is guaranteed — Playwright
    // does not promise that globalSetup runs before the web server.
    //
    // `next build && next start`, not `next dev`: dev regenerates the agent-file
    // block in AGENTS.md on boot, and a test run must not dirty the working tree.
    command: `npx tsx tests/ui/seed.ts && npx next build && npx next start --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    // Never reuse whatever is on :3000 — that is the developer's dev server,
    // pointed at the REAL queue. These tests write files and rows.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // The whole point: the app under test reads the fixture, never data/jobsearch.db.
      JOB_COPILOT_DB: DB,
      NODE_ENV: "production",
    },
  },
});
