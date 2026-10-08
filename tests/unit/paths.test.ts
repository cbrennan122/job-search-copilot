import { strict as assert } from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";

import { answersMdPathFor, docxPathFor, fileSlug, resumeMdPathFor } from "../../lib/paths";
import { makeJobId } from "../../lib/store";

const BUILDERS = [resumeMdPathFor, docxPathFor, answersMdPathFor];

/** A job key built the way the real queue builds one. */
function key(company: string, title: string, location: string) {
  return { id: makeJobId(title, company, location), company, title, location };
}

/** Assert two distinct jobs never share a generated filename, for every builder. */
function mustNotCollide(a: ReturnType<typeof key>, b: ReturnType<typeof key>, why: string) {
  assert.notEqual(a.id, b.id, `${why}: these must be two distinct jobs to begin with`);
  for (const build of BUILDERS) {
    assert.notEqual(build(a), build(b), `${build.name} collided on ${why}`);
  }
}

describe("generated file paths", () => {
  // Every case below is a pair of DISTINCT jobs — a one-instance test cannot see
  // this class of bug at all, because the whole failure mode is one job's file
  // being served for another's.
  it("keeps two jobs apart when only the location differs", () => {
    // 223 company+title groups in a 3313-row queue hold more than one job.
    mustNotCollide(
      key("Acme", "Senior SDET", "Remote"),
      key("Acme", "Senior SDET", "New York, NY"),
      "same company and title, different location",
    );
  });

  it("keeps two jobs apart when the titles differ only in punctuation", () => {
    // Measured on the real queue: 7 paths were still shared after location was
    // added, every one of them a punctuation variant like these.
    mustNotCollide(
      key("Ramp", "Solutions Consultant | Enterprise", "New York, NY (HQ)"),
      key("Ramp", "Solutions Consultant, Enterprise", "New York, NY (HQ)"),
      "pipe vs comma in the title",
    );
  });

  it("keeps two jobs apart when the titles agree for the first 60 characters", () => {
    // fileSlug truncates each segment at 60.
    const long = "Senior Software Engineer Backend Platform Infrastructure Team";
    mustNotCollide(
      key("Acme", `${long} AAAA`, "Remote"),
      key("Acme", `${long} BBBB`, "Remote"),
      "titles differing only past the 60-character slug cap",
    );
  });

  it("keeps two jobs apart when the text straddles a dash differently", () => {
    // The segments are joined with "-", which a slug can also contain.
    mustNotCollide(
      key("A", "B-C", "Remote"),
      key("A-B", "C", "Remote"),
      "a dash on either side of the company/title boundary",
    );
  });

  it("keeps the .docx and .md stems in step, so the download is named for its source", () => {
    const j = key("Acme", "Senior SDET", "New York, NY");
    const md = path.basename(resumeMdPathFor(j), ".md");
    assert.equal(path.basename(docxPathFor(j), ".docx"), md);
    assert.equal(path.basename(answersMdPathFor(j), ".md"), `${md}-answers`);
  });

  it("stays readable: company, title and location are all still in the name", () => {
    const name = path.basename(resumeMdPathFor(key("Acme", "Senior SDET", "New York, NY")));
    assert.match(name, /^Acme-Senior-SDET-New-York-NY-[0-9a-f]{8}\.md$/);
  });

  it("omits the location segment entirely when the board left it blank", () => {
    // fileSlug("") returns its "resume" fallback, which would put a meaningless
    // word in the filename of every job with an unfilled location field.
    const j = key("Acme", "Senior SDET", "   ");
    assert.match(path.basename(resumeMdPathFor(j)), /^Acme-Senior-SDET-[0-9a-f]{8}\.md$/);
  });

  it("cannot produce a path separator from a hostile location", () => {
    const nasty = resumeMdPathFor(key("Acme", "Senior SDET", "../../etc/passwd"));
    assert.equal(
      path.dirname(nasty),
      path.dirname(resumeMdPathFor(key("Acme", "Senior SDET", "R"))),
    );
    assert.ok(!path.basename(nasty).includes("/"));
  });

  it("keeps fileSlug's guarantees for each segment", () => {
    assert.equal(
      fileSlug("Senior SDET: Automation, API & Performance"),
      "Senior-SDET-Automation-API-Performance",
    );
    assert.equal(fileSlug(""), "resume");
  });
});
