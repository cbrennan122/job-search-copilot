import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildGapReport } from "../../lib/gaps";

// Read from `all`, not the three views: a term with no demand and no résumé
// mention is intentionally absent from every view.
const find = (r: ReturnType<typeof buildGapReport>, term: string) =>
  r.all.find((g) => g.term === term)!;

describe("buildGapReport", () => {
  it("separates gaps from strengths", () => {
    const r = buildGapReport(
      [{ title: "SRE", description: "Kubernetes and Rust required" }],
      "I have used Kubernetes for years.",
    );
    assert.equal(find(r, "Kubernetes").inResume, true);
    assert.equal(find(r, "Rust").inResume, false);
    assert.ok(r.gaps.some((g) => g.term === "Rust"));
    assert.ok(r.strengths.some((g) => g.term === "Kubernetes"));
  });

  it("counts jobs, not mentions", () => {
    // A verbose post saying "Kubernetes" five times is still one employer.
    const r = buildGapReport(
      [
        { title: "A", description: "kubernetes ".repeat(5) },
        { title: "B", description: "none" },
      ],
      "",
    );
    assert.equal(find(r, "Kubernetes").jobs, 1);
    assert.equal(find(r, "Kubernetes").share, 0.5);
  });

  it("credits SQL to someone who lists PostgreSQL", () => {
    // Regression: "PostgreSQL" does not contain a word-boundary "SQL", so the
    // report claimed SQL was missing from a résumé that plainly implies it.
    const r = buildGapReport(
      [{ title: "Data", description: "Strong SQL required" }],
      "**Databases:** PostgreSQL, Redis",
    );
    assert.equal(find(r, "SQL").inResume, true);
    assert.ok(!r.gaps.some((g) => g.term === "SQL"));
  });

  it("does not count the English word 'rest' as REST API demand", () => {
    const r = buildGapReport(
      [{ title: "Eng", description: "You will own the rest of the roadmap." }],
      "",
    );
    assert.equal(find(r, "REST APIs").jobs, 0);
  });

  it("does not count the verb 'go' as the Go language", () => {
    const r = buildGapReport(
      [{ title: "Eng", description: "Willing to go above and beyond." }],
      "",
    );
    assert.equal(find(r, "Go").jobs, 0);
  });

  it("still matches the Go language when it is a language", () => {
    const r = buildGapReport(
      [{ title: "Eng", description: "Services written in Go, Python." }],
      "",
    );
    assert.equal(find(r, "Go").jobs, 1);
  });

  it("does not treat JavaScript as Java", () => {
    const r = buildGapReport([{ title: "Eng", description: "JavaScript and TypeScript" }], "");
    assert.equal(find(r, "Java").jobs, 0);
    assert.equal(find(r, "JavaScript").jobs, 1);
  });

  it("handles an empty sample without dividing by zero", () => {
    const r = buildGapReport([], "anything");
    assert.equal(r.sampled, 0);
    assert.equal(r.gaps.length, 0);
    assert.ok(Number.isFinite(find(r, "Kubernetes").share));
  });
});
