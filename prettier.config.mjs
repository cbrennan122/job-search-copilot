// Formatting gate. Added 2026-08-27 — before this, there was none: eslint here is
// eslint-config-next, which enforces correctness and Next conventions but no
// layout at all, and passes a deliberately mangled file with exit 0.
//
// printWidth 100 is not a preference, it is the measured minimum: at the default
// 80 it rewrites 44 of 59 files and at 120 it rewrites 43, against 36 here. The
// rest of the settings are prettier's defaults, which already match how this
// repo was written (double quotes, semicolons, 2-space, trailing commas).
//
// The prettier dependency is pinned EXACTLY (no ^) on purpose: a patch release
// that changes one formatting decision would turn every PR red for reasons the
// author did not cause.
/** @type {import("prettier").Config} */
const config = {
  printWidth: 100,
};

export default config;
