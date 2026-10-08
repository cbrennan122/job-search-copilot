// Loads and validates profile/profile.toml — your targeting config.

import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

/**
 * A role family for the preference ranking. OPTIONAL: omit the section and the
 * built-in DEFAULT_CATEGORIES apply, so an existing profile.toml keeps working.
 *
 * The shape is declared here and the defaults live in lib/categories.ts, which
 * keeps the dependency one-way (categories -> profile). TypeScript checks the
 * two against each other where activeCategories() assigns this to RoleCategory[].
 */
const CategorySchema = z.object({
  id: z.string(),
  label: z.string(),
  weight: z.number(),
  patterns: z.array(z.string()).default([]),
});

const ProfileSchema = z.object({
  match: z.object({
    titles: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([]),
    deprioritize: z.array(z.string()).default([]),
    // REQUIRED, and deliberately without a default. Targeting has to name the
    // countries you would actually take a job in; there is no "anywhere"
    // option, because "anywhere" is what filled the queue with roles in
    // Bengaluru and Managua. Resolved to ids by lib/locations.ts, which also
    // rejects a name it does not recognise rather than silently ignoring it.
    countries: z.array(z.string()).min(1),
    remote_only: z.boolean().default(false),
    prefilter_threshold: z.number().default(25),
    categories: z.array(CategorySchema).optional(),
  }),
  greenhouse: z.object({ companies: z.array(z.string()).default([]) }).default({ companies: [] }),
  lever: z.object({ companies: z.array(z.string()).default([]) }).default({ companies: [] }),
  ashby: z.object({ companies: z.array(z.string()).default([]) }).default({ companies: [] }),
  remoteok: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  jsearch: z
    .object({
      queries: z.array(z.string()).default([]),
      pages: z.number().default(1),
    })
    .default({ queries: [], pages: 1 }),
  // Free, but both need registration keys — the pipeline skips them unless the
  // env vars are present, so leaving these configured but unkeyed is harmless.
  usajobs: z
    .object({
      queries: z.array(z.string()).default([]),
      results_per_page: z.number().max(500).default(100),
    })
    .default({ queries: [], results_per_page: 100 }),
  adzuna: z
    .object({
      country: z.string().default("us"),
      queries: z.array(z.string()).default([]),
      pages: z.number().default(1),
      results_per_page: z.number().max(50).default(50),
    })
    .default({ country: "us", queries: [], pages: 1, results_per_page: 50 }),
});

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Thrown when the profile file itself is absent — the fresh-clone and CI case,
 * since profile/ is gitignored.
 *
 * A distinct class rather than a bare Error so a caller can tolerate "no config
 * here" without also swallowing a malformed TOML or a permissions failure.
 * lib/categories.ts is the caller that needs the distinction: it falls back to
 * built-in defaults on this one, and rethrows everything else.
 */
export class MissingProfileError extends Error {}

/**
 * Where profile.toml and resume_base.md live. JOB_COPILOT_PROFILE_DIR overrides
 * it, mirroring JOB_COPILOT_DB and for the same reason: the test suite needs to
 * run against known config rather than whatever the developer happens to have
 * targeted locally. Resolved per call, so setting the var before the first read
 * is enough.
 *
 * The default branch spells out `path.join(process.cwd(), "profile", name)`
 * literally rather than joining a computed directory. Turbopack statically
 * analyses filesystem access, and a non-literal base made it give up and trace
 * the ENTIRE project into the server bundle — a build warning that says
 * "this leads to all source files being deployed as part of the server code".
 * Keeping the ordinary path literal keeps that analysis working; the override
 * branch is dev/test only.
 */
function profilePath(name: string): string {
  const override = process.env.JOB_COPILOT_PROFILE_DIR;
  return override ? path.join(override, name) : path.join(process.cwd(), "profile", name);
}

/**
 * Read a profile file, pointing at the committed `.example` template when the real
 * one is missing. Both real files are gitignored — they hold personal contact details
 * and a private target-company list — so a fresh clone has only the examples.
 */
function readProfileFile(name: string, example: string): string {
  const file = profilePath(name);
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    throw new MissingProfileError(
      `Missing profile/${name}. Copy the template and fill it in with your own details:\n` +
        `  cp profile/${example} profile/${name}\n` +
        `It is gitignored on purpose — keep your real résumé and target list out of git.`,
    );
  }
}

export function loadProfile(): Profile {
  const raw = parse(readProfileFile("profile.toml", "profile.example.toml"));
  return ProfileSchema.parse(raw);
}

export function loadResumeBase(): string {
  return readProfileFile("resume_base.md", "resume_base.example.md");
}
