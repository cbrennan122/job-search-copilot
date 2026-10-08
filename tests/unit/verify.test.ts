import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatReport, verifyAgainstBase } from "../../lib/verify";

const BASE = `# Jordan Rivera

## Professional Experience

### Northwind Systems – Austin, TX / Remote

**Senior Backend Engineer | Mar 2023 – Present**

- Led migration of a monolithic billing service to five Go microservices, cutting p99
  latency from 1.8s to 240ms.

### Cobalt Data – Remote

**Backend Engineer | Jun 2020 – Mar 2023**

- Designed an event ingestion pipeline handling 40M events/day on Kafka and Postgres.
- Reduced CI runtime by 55% by parallelizing test suites.

## Skills

**Languages:** Go, Python, TypeScript/JavaScript
**Infrastructure:** Docker, Kubernetes, Terraform, Kafka (event streaming)
**Log Analysis:** Kibana, OpenSearch (ELK-family log aggregation)
`;

describe("verifyAgainstBase", () => {
  it("passes a résumé that only re-emphasizes real content", () => {
    // Reworded and reordered, but every hard fact traces back to the master.
    const tailored = `## Professional Experience

### Northwind Systems – Austin, TX / Remote

**Senior Backend Engineer | Mar 2023 – Present**

- Cut p99 latency from 1.8s to 240ms by decomposing a billing monolith into Go services.

### Cobalt Data – Remote

**Backend Engineer | Jun 2020 – Mar 2023**

- Built a 40M events/day ingestion pipeline; reduced CI runtime 55%.
`;
    const r = verifyAgainstBase(tailored, BASE);
    assert.equal(r.ok, true, JSON.stringify(r.unsupported, null, 2));
    assert.ok(r.checked > 0, "it actually checked something");
  });

  it("catches an invented employer", () => {
    const tailored = `### Initech Global – Remote\n\n**Staff Engineer | Mar 2023 – Present**\n`;
    const r = verifyAgainstBase(tailored, BASE);
    assert.equal(r.ok, false);
    assert.ok(
      r.unsupported.some((c) => c.kind === "employer" && c.value.includes("Initech")),
      "Initech Global flagged",
    );
  });

  it("catches an invented date", () => {
    const tailored = `### Northwind Systems – Austin, TX / Remote\n\n**Senior Backend Engineer | Mar 2017 – Present**\n`;
    const r = verifyAgainstBase(tailored, BASE);
    assert.equal(r.ok, false);
    assert.ok(r.unsupported.some((c) => c.kind === "date" && c.value === "2017"));
  });

  it("catches an inflated metric", () => {
    // The classic failure: a real 55% quietly becomes 95%.
    const tailored = `- Reduced CI runtime by 95% by parallelizing test suites.\n`;
    const r = verifyAgainstBase(tailored, BASE);
    assert.equal(r.ok, false);
    assert.ok(r.unsupported.some((c) => c.kind === "metric" && c.value === "95%"));
  });

  it("tolerates reformatting of a real metric", () => {
    // "40M" rendered as "40 M" is a formatting change, not a new claim.
    const r = verifyAgainstBase(`- Handled 40 M events/day.\n`, BASE);
    assert.equal(r.ok, true, JSON.stringify(r.unsupported));
  });

  it("ignores standard section headings", () => {
    const r = verifyAgainstBase(`## Skills\n## Professional Experience\n`, BASE);
    assert.equal(r.ok, true, JSON.stringify(r.unsupported));
  });

  it("catches a tool invented on a skills line", () => {
    // The likeliest fabrication of all: the JD names a tool, and one more
    // comma-separated entry looks like nothing next to an invented employer.
    const tailored = `**Infrastructure:** Docker, Kubernetes, Prometheus, Terraform\n`;
    const r = verifyAgainstBase(tailored, BASE);
    assert.equal(r.ok, false);
    assert.ok(
      r.unsupported.some((c) => c.kind === "skill" && c.value === "Prometheus"),
      `Prometheus flagged, got ${JSON.stringify(r.unsupported)}`,
    );
  });

  it("does not auto-support a wordy claim via the numeric fallback", () => {
    // Regression: support fell back to comparing bare digits, and a claim with
    // no digits reduces to "", which every string .includes(). That made the
    // whole skill check vacuous — it passed a résumé listing Prometheus,
    // Grafana and OpenTelemetry against a base containing none of them.
    const r = verifyAgainstBase(`**Observability:** Grafana, OpenTelemetry\n`, BASE);
    assert.equal(r.ok, false, "digit-free skills must not be auto-supported");
    assert.equal(r.unsupported.length, 2);
  });

  it("does not support a metric whose digits merely sit inside another number", () => {
    // Regression: the numeric fallback compared the claim's digits against a
    // *concatenated* blob of every digit in the base, so "23%" was reported as
    // supported because the base says "Mar 2023". Every résumé carries years,
    // which made a large share of invented percentages verify clean.
    const r = verifyAgainstBase("- Improved throughput by 23% after a rewrite.\n", BASE);
    assert.equal(r.ok, false, "23% is nowhere in the master résumé");
    assert.ok(
      r.unsupported.some((c) => c.kind === "metric" && c.value.includes("23%")),
      "the fabricated 23% is the flagged claim",
    );
  });

  it("does not support a metric that is a digit-substring of a real one", () => {
    // "40M events/day" is real; "40M" inside "1.40" or "140" is not the same
    // figure. Support must compare whole numbers, not substrings of them.
    const r = verifyAgainstBase("- Cut incident MTTR by 0M in a quarter.\n", BASE);
    assert.equal(r.ok, false, "0M is not 40M");
  });

  it("still accepts a real metric written with different spacing", () => {
    // Positive control for the two tests above: tightening the numeric fallback
    // must not break the case it exists to serve.
    const r = verifyAgainstBase("- Handled 40 M events/day on Kafka.\n", BASE);
    assert.equal(r.ok, true, JSON.stringify(r.unsupported));
  });

  it("does not support a skill that is only a substring of an unrelated word", () => {
    // Regression: support was a raw substring test, so a fabricated short tool
    // passed whenever its letters appeared inside any word in the base. The
    // master résumé says "TypeScript/JavaScript" and never mentions Java — the
    // single most consequential version of this, since the two are unrelated
    // languages and "Java" is exactly what a JD-matching model would add.
    const r = verifyAgainstBase("**Languages:** Java, Python\n", BASE);
    assert.equal(r.ok, false, "Java is not JavaScript");
    assert.ok(
      r.unsupported.some((c) => c.kind === "skill" && c.value === "Java"),
      "Java flagged, Python not",
    );
  });

  it("does not support an employer that is a substring of real prose", () => {
    // The base mentions "Kafka and Postgres"; "Post" is not an employer there.
    const r = verifyAgainstBase("At Post I ran the ingestion pipeline.\n", BASE);
    assert.equal(r.ok, false, "Post is not a real employer in the master résumé");
  });

  it("allows real skills to be reordered and recategorized", () => {
    // Regrouping "Kubernetes" under a heading that matches the job's wording is
    // explicitly permitted; only the entries themselves have to be real.
    const tailored = `**Cloud & Orchestration:** Kubernetes, Docker, Terraform\n**Languages:** Go, Python\n`;
    const r = verifyAgainstBase(tailored, BASE);
    assert.equal(r.ok, true, JSON.stringify(r.unsupported));
  });

  it("checks a parenthetical gloss separately from the tool it annotates", () => {
    // "Flux (GitOps)" is a real tool plus a new label. Flagging the entry whole
    // would read as "Flux is invented", which is both wrong and the kind of
    // false alarm that gets a checker ignored.
    const r = verifyAgainstBase(`**Infrastructure:** Kafka (message bus)\n`, BASE);
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.unsupported.map((c) => c.value),
      ["message bus"],
      "the gloss is flagged; Kafka itself is supported",
    );
    // And a gloss the master résumé does carry stays quiet.
    assert.equal(
      verifyAgainstBase(`**Log Analysis:** OpenSearch (ELK-family log aggregation)\n`, BASE).ok,
      true,
    );
  });

  it("splits on commas outside parentheses only", () => {
    // "Kubernetes (EKS, GKE)" is one entry; splitting naively invents a claim
    // called "GKE)" and flags it.
    const r = verifyAgainstBase(`**Infrastructure:** Kubernetes (Docker, Terraform)\n`, BASE);
    assert.equal(r.ok, true, JSON.stringify(r.unsupported));
  });

  it("ignores bold-label prose rather than splitting it on commas", () => {
    // A bullet is prose. Splitting its clauses on commas would flag most of a
    // sentence, one fragment at a time.
    const r = verifyAgainstBase(
      `- **Note:** shipped Go, Python, and Kubernetes work across three teams.\n`,
      BASE,
    );
    assert.equal(r.ok, true, JSON.stringify(r.unsupported));
  });

  it("catches an employer invented in prose, where a letter has no headings", () => {
    // A cover letter is unbroken prose: no headings, often no years or figures.
    // Heading-only employer detection finds nothing there, so a draft claiming a
    // job at Netflix verified clean.
    const letter = `At Netflix I ran the global edge caching tier, and at Cobalt Data I built ingestion.\n`;
    const r = verifyAgainstBase(letter, BASE);
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.unsupported.map((c) => c.value),
      ["Netflix"],
      "Netflix flagged; Cobalt Data is real and stays quiet",
    );
  });

  it("matches a sentence-initial preposition, not just a mid-sentence one", () => {
    // "At Netflix…" opening a sentence is the common shape. Matching only
    // lowercase "at" let exactly that case through.
    const r = verifyAgainstBase(`At Initech Global I led platform work.\n`, BASE);
    assert.equal(r.ok, false);
    assert.ok(r.unsupported.some((c) => c.value === "Initech Global"));
  });

  it("does not flag the company being applied to", () => {
    // A cover letter names its target company repeatedly; that is not a claim
    // of having worked there.
    const letter = `I want to work at Vandelay Industries because of its platform work.\n`;
    assert.equal(verifyAgainstBase(letter, BASE).ok, false, "unlisted -> flagged");
    assert.equal(
      verifyAgainstBase(letter, BASE, ["Vandelay Industries"]).ok,
      true,
      "listed as mentionable -> quiet",
    );
  });

  it("does not mistake ordinary prose after a preposition for a company", () => {
    const r = verifyAgainstBase(
      `I work with Python daily and care about reliability at scale. At The end I shipped it.\n`,
      BASE,
    );
    assert.equal(r.ok, true, JSON.stringify(r.unsupported));
  });

  it("refuses to report a pass when it checked nothing", () => {
    // "Nothing was wrong" and "nothing was examined" must not read alike — that
    // tick is what would let an unverified document go out.
    const r = verifyAgainstBase(`Thanks for your time.\n`, BASE);
    assert.equal(r.checked, 0);
    const text = formatReport(r);
    assert.ok(!text.includes("✓"), `no success tick, got: ${text}`);
    assert.match(text, /NOT a pass/);
  });

  it("does not flag a real employer just because a sentence ends on it", () => {
    // "…at Cobalt Data. My role grew." captures the period AND the next
    // sentence's first word, so a real employer reads as unsupported. This
    // shape is everywhere in cover-letter prose.
    const r = verifyAgainstBase(
      `I built ingestion at Cobalt Data. My role grew from there.\n` +
        `I worked with Terraform. The team shipped weekly.\n`,
      BASE,
    );
    assert.equal(r.ok, true, JSON.stringify(r.unsupported));
  });
});
