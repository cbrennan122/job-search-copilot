import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatSalaryRange } from "../../lib/money";

describe("formatSalaryRange", () => {
  it("formats a two-sided range", () => {
    assert.equal(formatSalaryRange(120000, 150000), "$120K – $150K");
  });

  it("marks an open-ended minimum and a bare maximum", () => {
    assert.equal(formatSalaryRange(120000, null), "$120K+");
    assert.equal(formatSalaryRange(null, 150000), "$150K max");
  });

  it("treats 0 as unset, not as a real $0 salary", () => {
    // RemoteOK sends salary_min: 0 / salary_max: 0 on ~98% of rows.
    assert.equal(formatSalaryRange(0, 0), null);
    assert.equal(formatSalaryRange(0, 150000), "$150K max");
  });

  it("returns null when there is nothing to show", () => {
    assert.equal(formatSalaryRange(null, null), null);
    assert.equal(formatSalaryRange(undefined, undefined), null);
  });

  it("uses the right symbol per currency and falls back to a suffix", () => {
    assert.equal(formatSalaryRange(50000, 60000, "GBP"), "£50K – £60K");
    assert.equal(formatSalaryRange(50000, 60000, "EUR"), "€50K – €60K");
    assert.equal(formatSalaryRange(50000, 60000, "SEK"), "50K SEK – 60K SEK");
  });

  it("labels a period so an hourly rate is not read as an annual typo", () => {
    assert.equal(formatSalaryRange(28, 34, "USD", "hour"), "$28 – $34 / hour");
  });

  it("keeps sub-1000 values unscaled", () => {
    assert.equal(formatSalaryRange(500, 900), "$500 – $900");
  });
});
