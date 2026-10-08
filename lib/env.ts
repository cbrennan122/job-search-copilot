// Env loading for CLI entry points.
//
// Next.js reads .env.local automatically, but a bare `tsx scripts/foo.ts` does
// NOT — so every CLI path that needs ANTHROPIC_API_KEY has to ask for it. This
// used to be a try/catch pasted into individual scripts, and scripts/fetch.ts
// was missing it: a full scored run then wrote 480 rows of "LLM scoring failed
// (ANTHROPIC_API_KEY is not set)" and exited 0, because scoring falls back to
// the prefilter score rather than crashing. Silent, and expensive to notice.

import path from "node:path";

let loaded = false;

/**
 * Load .env.local into process.env if it exists. Idempotent, and never
 * overrides a variable already set in the real environment (so
 * `ANTHROPIC_API_KEY=… npm run fetch` still wins).
 *
 * Resolved against cwd, matching lib/store.ts and lib/profile.ts — the whole
 * app assumes it is run from the repo root.
 */
export function loadLocalEnv(): void {
  if (loaded) return;
  loaded = true;
  try {
    process.loadEnvFile(path.join(process.cwd(), ".env.local"));
  } catch (err) {
    // No .env.local is a legitimate setup (CI, or vars exported by the shell).
    // Anything else is a real problem worth seeing.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Fail fast when a CLI needs a key that isn't there, instead of letting the
 * per-job fallback quietly degrade a whole run.
 */
export function requireEnv(name: string): string {
  loadLocalEnv();
  const v = process.env[name];
  if (!v) {
    console.error(
      `${name} is not set. Copy .env.local.example to .env.local and fill it in,\n` +
        `or export it in your shell. (Pass --no-score to skip the steps that need it.)`,
    );
    process.exit(1);
  }
  return v;
}
