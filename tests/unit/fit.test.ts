import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// prefilterScore now asks lib/locations.ts whether a posting is reachable, and
// that reads profile.toml. Point it at nothing so the fallback (United States)
// applies — profile/ is gitignored, so it is absent in CI and present locally,
// and without this the location assertions below would depend on whatever
// countries the developer happens to have configured.
process.env.JOB_COPILOT_PROFILE_DIR = path.join(tmpdir(), `job-copilot-no-profile-${randomUUID()}`);

import { prefilterScore } from "../../lib/fit";
import type { Profile } from "../../lib/profile";
import type { Job } from "../../lib/types";

const profile = {
  match: {
    titles: ["site reliability", "devops"],
    keywords: ["terraform", "kubernetes", "aws", "ci/cd"],
    deprioritize: ["intern", "junior"],
    countries: ["United States"],
    remote_only: false,
    prefilter_threshold: 25,
  },
} as Profile;

function job(over: Partial<Job>): Job {
  return {
    id: "id",
    source: "greenhouse",
    sourceJobId: "x",
    title: "Engineer",
    company: "Acme",
    location: "New York, NY",
    remote: false,
    description: "",
    url: "",
    postedAt: null,
    fetchedAt: "",
    compensation: null,
    employmentType: null,
    department: null,
    ...over,
  };
}

describe("prefilterScore", () => {
  it("rewards a title match far more than a body mention", () => {
    const inTitle = prefilterScore(job({ title: "Site Reliability Engineer" }), profile);
    const inBody = prefilterScore(
      job({ title: "Engineer", description: "join our site reliability team" }),
      profile,
    );
    assert.ok(inTitle > inBody, `${inTitle} should beat ${inBody}`);
  });

  it("stacks keyword hits but caps their contribution", () => {
    const one = prefilterScore(job({ description: "terraform" }), profile);
    const many = prefilterScore(job({ description: "terraform kubernetes aws ci/cd" }), profile);
    assert.ok(many > one);
    assert.ok(many <= 100);
  });

  it("penalizes deprioritized titles", () => {
    const normal = prefilterScore(job({ title: "DevOps Engineer" }), profile);
    const junior = prefilterScore(job({ title: "Junior DevOps Engineer" }), profile);
    assert.ok(junior < normal, `${junior} should be below ${normal}`);
  });

  it("zeroes non-remote roles when remote_only is set", () => {
    const strict = { match: { ...profile.match, remote_only: true } } as Profile;
    assert.equal(prefilterScore(job({ title: "DevOps Engineer" }), strict), 0);
    assert.ok(prefilterScore(job({ title: "DevOps Engineer", remote: true }), strict) > 0);
  });

  it("gives the location bonus by country, not by substring", () => {
    // Both are non-remote and otherwise identical, so the only difference is
    // the +10 the country classifier grants a reachable posting. The London row
    // is the regression this whole change exists for: it used to score the same
    // as the Austin one, because "remote"/"united states" never appeared in
    // either string and neither did anything else the old list matched.
    const domestic = prefilterScore(
      job({ title: "DevOps Engineer", location: "Austin, TX", remote: false }),
      profile,
    );
    const foreign = prefilterScore(
      job({ title: "DevOps Engineer", location: "London, United Kingdom", remote: false }),
      profile,
    );
    assert.equal(domestic - foreign, 10);
  });

  it("stays inside 0-100", () => {
    const best = prefilterScore(
      job({
        title: "Site Reliability Engineer",
        location: "Remote, United States",
        remote: true,
        description: "terraform kubernetes aws ci/cd",
      }),
      profile,
    );
    const worst = prefilterScore(job({ title: "Junior Intern" }), profile);
    assert.ok(best <= 100 && best > 0);
    assert.equal(worst, 0);
  });
});
