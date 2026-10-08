// Write a generated file, creating its parent directory first.
//
// Generated application output lives in `resumes/`, which is gitignored — so on
// a fresh clone that directory does not exist, and a bare writeFileSync fails
// with ENOENT. For scripts/tailor.ts and scripts/cover-letter.ts that failure
// lands AFTER the LLM call, so the work is paid for and then thrown away.
// Creating the parent is what makes `--out resumes/<file>` work for someone who
// did not happen to mkdir it by hand.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeOutput(path: string, data: string | Uint8Array): void {
  // dirname("tailored.md") is ".", and mkdir -p on "." is a harmless no-op, so
  // a bare filename still behaves exactly as it did before.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}
