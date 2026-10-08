// Skills-gap report: which technologies keep showing up in the jobs you score
// well on, and which of those your résumé never mentions.
//
// Deliberately deterministic — no LLM, no network, no spend. It counts term
// occurrences across job descriptions and diffs against the master résumé, so
// the output is reproducible and auditable. An LLM could phrase it more nicely
// but would also happily invent a trend that isn't in the data.

/**
 * Vocabulary of things a résumé can actually claim. Matching against a fixed
 * list rather than mining arbitrary n-grams keeps the output readable: free
 * n-grams surface "strong communication skills" and "fast-paced environment",
 * which are not skills gaps you can act on.
 */
const VOCAB: Array<[term: string, demand: RegExp, resume?: RegExp]> = [
  ["Kubernetes", /\b(kubernetes|k8s)\b/i],
  ["Docker", /\bdocker\b/i],
  ["Terraform", /\bterraform\b/i],
  ["Pulumi", /\bpulumi\b/i],
  ["Ansible", /\bansible\b/i],
  ["AWS", /\baws\b|\bamazon web services\b/i],
  ["GCP", /\bgcp\b|\bgoogle cloud\b/i],
  ["Azure", /\bazure\b/i],
  ["CI/CD", /\bci\/cd\b|\bcontinuous (integration|delivery|deployment)\b/i],
  ["GitHub Actions", /\bgithub actions\b/i],
  ["Jenkins", /\bjenkins\b/i],
  ["ArgoCD", /\bargo\s?cd\b/i],
  ["GitOps", /\bgitops\b/i],
  ["Helm", /\bhelm\b/i],
  ["Prometheus", /\bprometheus\b/i],
  ["Grafana", /\bgrafana\b/i],
  ["Datadog", /\bdatadog\b/i],
  ["OpenTelemetry", /\bopen ?telemetry\b|\botel\b/i],
  ["Observability", /\bobservability\b/i],
  ["Python", /\bpython\b/i],
  // Case-SENSITIVE on purpose: "Go" is the language, "go" is a verb that
  // appears in nearly every job description ("go above and beyond").
  ["Go", /\bgolang\b|\bGo\b(?=[,./)\s])/],
  ["TypeScript", /\btypescript\b/i],
  ["JavaScript", /\bjavascript\b/i],
  ["Java", /\bjava\b(?!script)/i],
  ["Rust", /\brust\b/i],
  ["Ruby", /\bruby\b/i],
  ["C#", /\bc#\b|\b\.net\b/i],
  ["Bash", /\bbash\b|\bshell scripting\b/i],
  // Third pattern = what counts as having it on your résumé. Someone who
  // lists PostgreSQL plainly knows SQL; flagging it as a gap is noise.
  [
    "SQL",
    /\bsql\b/i,
    /\bsql\b|\bpostgres(ql)?\b|\bmysql\b|\bsqlite\b|\bmariadb\b|\bt-sql\b|\bpl\/?sql\b/i,
  ],
  ["PostgreSQL", /\bpostgres(ql)?\b/i],
  ["MySQL", /\bmysql\b/i],
  ["Redis", /\bredis\b/i],
  ["MongoDB", /\bmongodb\b/i],
  ["Kafka", /\bkafka\b/i],
  ["RabbitMQ", /\brabbitmq\b/i],
  ["Spark", /\bspark\b/i],
  ["Airflow", /\bairflow\b/i],
  ["Snowflake", /\bsnowflake\b/i],
  ["dbt", /\bdbt\b/i],
  ["React", /\breact\b/i],
  ["Node.js", /\bnode\.?js\b/i],
  ["Django", /\bdjango\b/i],
  ["FastAPI", /\bfastapi\b/i],
  ["Flask", /\bflask\b/i],
  ["Spring", /\bspring boot\b|\bspring\b/i],
  ["GraphQL", /\bgraphql\b/i],
  ["gRPC", /\bgrpc\b/i],
  // NOT /\brest\b/ — that matches "the rest of the team" in half of all JDs.
  ["REST APIs", /\brest(ful)?[\s-]?(api|service|endpoint)/i],
  ["Microservices", /\bmicroservices?\b/i],
  ["Async programming", /\basync(hronous)?\b|\basyncio\b|\basync\/await\b/i],
  ["Linux", /\blinux\b/i],
  ["Networking", /\bnetworking\b|\btcp\/ip\b|\bdns\b/i],
  ["Security", /\bsecurity\b|\bappsec\b|\bdevsecops\b/i],
  ["Pytest", /\bpytest\b/i],
  ["Playwright", /\bplaywright\b/i],
  ["Selenium", /\bselenium\b/i],
  ["Cypress", /\bcypress\b/i],
  ["k6", /\bk6\b/i],
  ["JMeter", /\bjmeter\b/i],
  ["Load testing", /\bload testing\b|\bperformance testing\b/i],
  ["Test automation", /\btest automation\b|\bautomated testing\b/i],
  ["SRE practices", /\bsre\b|\bsite reliability\b|\bslo\b|\bsli\b|\berror budget\b/i],
  ["Incident response", /\bincident (response|management)\b|\bon-?call\b/i],
  ["Machine learning", /\bmachine learning\b|\b\bml\b/i],
  ["LLM / GenAI", /\bllm\b|\bgenerative ai\b|\bgen ?ai\b/i],
];

export interface Gap {
  term: string;
  /** How many of the sampled job descriptions ask for it. */
  jobs: number;
  /** Share of sampled jobs, 0-1. */
  share: number;
  inResume: boolean;
}

export interface GapReport {
  sampled: number;
  /** Every vocabulary term with its counts — the three lists below are views
   *  over this, and a term that is neither in demand nor on the résumé appears
   *  in none of them. */
  all: Gap[];
  /** Wanted by the market, absent from the résumé — sorted by demand. */
  gaps: Gap[];
  /** On the résumé and in demand — worth keeping prominent. */
  strengths: Gap[];
  /** On the résumé but rarely asked for in this sample. */
  unused: Gap[];
}

export interface GapInput {
  title: string;
  description: string;
}

export function buildGapReport(jobs: GapInput[], resume: string): GapReport {
  const counts = new Map<string, number>();
  for (const [term] of VOCAB) counts.set(term, 0);

  for (const job of jobs) {
    const text = `${job.title}\n${job.description}`;
    for (const [term, demand] of VOCAB) {
      // Count jobs, not mentions: a JD that says "Kubernetes" nine times is one
      // employer asking for it, and raw mention counts just rank verbose posts.
      if (demand.test(text)) counts.set(term, counts.get(term)! + 1);
    }
  }

  const rows: Gap[] = VOCAB.map(([term, demand, resumeRe]) => ({
    term,
    jobs: counts.get(term)!,
    share: jobs.length ? counts.get(term)! / jobs.length : 0,
    // Demand and possession are different questions, so some terms match more
    // broadly on the résumé side than on the job side.
    inResume: (resumeRe ?? demand).test(resume),
  }));

  const byDemand = (a: Gap, b: Gap) => b.jobs - a.jobs || a.term.localeCompare(b.term);

  return {
    sampled: jobs.length,
    all: rows,
    gaps: rows.filter((r) => !r.inResume && r.jobs > 0).sort(byDemand),
    strengths: rows.filter((r) => r.inResume && r.jobs > 0).sort(byDemand),
    unused: rows.filter((r) => r.inResume && r.jobs === 0).sort(byDemand),
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function formatGapReport(r: GapReport, limit = 15): string {
  if (r.sampled === 0) {
    return "No jobs matched the filter — score some jobs first, or lower --min-fit.";
  }
  const lines = [`Skills gap report — ${r.sampled} job descriptions sampled`, ""];

  lines.push(`## Missing from your résumé (${r.gaps.length})`);
  if (r.gaps.length === 0) lines.push("  (nothing — your résumé covers the sample)");
  for (const g of r.gaps.slice(0, limit)) {
    lines.push(`  ${pct(g.share).padStart(4)}  ${String(g.jobs).padStart(4)} jobs   ${g.term}`);
  }

  lines.push("", `## On your résumé and in demand (${r.strengths.length})`);
  for (const g of r.strengths.slice(0, limit)) {
    lines.push(`  ${pct(g.share).padStart(4)}  ${String(g.jobs).padStart(4)} jobs   ${g.term}`);
  }

  if (r.unused.length) {
    lines.push("", `## On your résumé, absent from this sample (${r.unused.length})`);
    lines.push(`  ${r.unused.map((g) => g.term).join(", ")}`);
  }

  lines.push(
    "",
    "Gaps are learning targets, not disqualifiers — a stretch application is a",
    "deliberate strategy. Nothing here should be added to your résumé unless you",
    "have actually done it.",
  );
  return lines.join("\n");
}
