"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { APPLICATION_STATUSES, FALLBACK_MODEL, type JobListItem } from "@/lib/types";

const PAGE_SIZE = 50;

/**
 * How long to wait after the last keystroke before querying. Long enough that
 * typing a company name is one request rather than eight, short enough to still
 * feel live.
 */
const SEARCH_DEBOUNCE_MS = 250;

interface CategoryOption {
  id: string;
  label: string;
}

function fitClass(score: number | null | undefined) {
  if (score == null) return "none";
  if (score >= 75) return "good";
  if (score >= 50) return "mid";
  return "low";
}

export default function Home() {
  const [jobs, setJobs] = useState<JobListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [minFit, setMinFit] = useState("50");
  const [status, setStatus] = useState("new");
  // "" = every family, which is the default: the score-ordered view that existed
  // before categories did is still the one you land on.
  const [category, setCategory] = useState("");
  // Served with each page rather than hardcoded, so the options always match the
  // families the server actually classifies by (see /api/jobs).
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  // "mine" hides postings in countries profile.toml doesn't name. Nothing is
  // deleted — "all" brings them straight back, ranked below comparable jobs.
  const [locations, setLocations] = useState("mine");
  // "" = any age, and that is deliberately the default: this filter hides rows
  // that are still open, so a non-neutral default would silently shrink the
  // queue on first load with nothing on screen to explain it. Board sources
  // (greenhouse/lever/ashby) are delisted properly and are unaffected either
  // way; this exists for the search feeds, which declare no scopes and so can
  // never be auto-closed however many times you fetch.
  const [maxAgeDays, setMaxAgeDays] = useState("");
  // Two pieces of state on purpose: `search` is what the input shows (updated on
  // every keystroke, so typing never stutters) and `q` is what the effect
  // queries with, which trails it by SEARCH_DEBOUNCE_MS.
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Bumping this re-runs the load effect; it replaces a useCallback `load()`
  // that the react-hooks lint flagged for setting state synchronously in an
  // effect body.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    // Only debounce once the box has actually diverged from what was queried.
    // Without this guard the mount run schedules a timer that fires 250ms later
    // and flips `loading` back on, while `setQ("")`/`setOffset(0)` are no-ops
    // because those are already the current values — so NO dependency of the
    // load effect changes, it never re-runs, and nothing ever sets `loading`
    // false again. The page then sits on "Loading…" holding results it has
    // already fetched, until something bumps a real dependency (the Update
    // button's `reload`). /api/jobs answers in ~8ms against 250ms of debounce,
    // so the timer wins that race every time locally.
    if (search === q) return;
    const t = setTimeout(() => {
      setLoading(true);
      setOffset(0); // a new search invalidates the current page number
      setQ(search);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search, q]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (minFit) params.set("minFit", minFit);
    if (status) params.set("status", status);
    if (category) params.set("category", category);
    if (locations) params.set("locations", locations);
    if (maxAgeDays) params.set("maxAgeDays", maxAgeDays);
    if (q) params.set("q", q);

    (async () => {
      try {
        const res = await fetch(`/api/jobs?${params}`);
        const data = await res.json();
        // Guard against a slower earlier request landing after a newer one and
        // overwriting the current filter's results.
        if (cancelled) return;
        setJobs(data.jobs ?? []);
        setTotal(data.total ?? 0);
        setCategories(data.categories ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [minFit, status, category, locations, maxAgeDays, q, offset, reload]);

  function changeFilter(set: (v: string) => void, v: string) {
    setLoading(true);
    setOffset(0); // a filter change invalidates the current page number
    set(v);
  }

  /**
   * "Not interested": park the job in the existing `skipped` status. No new
   * route and no schema change — `skipped` is already terminal, already excluded
   * from follow-ups, and already offered on the detail page.
   */
  async function dismiss(job: JobListItem) {
    const previous = jobs;
    const previousTotal = total;
    // Whether the row should vanish depends on the filter in force: with Status
    // set to "skipped" or to "all" it still belongs on screen, and splicing it
    // out unconditionally would make it look deleted.
    const hides = status !== "" && status !== "skipped";
    setJobs(
      hides
        ? jobs.filter((j) => j.id !== job.id)
        : jobs.map((j) => (j.id === job.id ? { ...j, status: "skipped" as const } : j)),
    );
    if (hides) setTotal((n) => Math.max(0, n - 1));

    const res = await fetch("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: job.id, status: "skipped" }),
    }).catch(() => null);

    if (!res || !res.ok) {
      // Put it back rather than leaving the UI claiming a change the DB never
      // took: the next reload would resurrect the row with no explanation.
      setJobs(previous);
      setTotal(previousTotal);
      setNote(`Could not dismiss “${job.title}”. It is still in the queue.`);
    }
  }

  async function runFetch() {
    setRunning(true);
    setNote(null);
    try {
      const res = await fetch("/api/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ score: true }),
      });
      const data = await res.json();
      if (data.error) {
        setNote(`Error: ${data.error}`);
      } else {
        const r = data.result;
        setNote(
          `Fetched ${r.fetched} — ${r.inserted} new, ${r.updated} refreshed, ` +
            `${r.closed} delisted. Scored ${r.scored}.`,
        );
      }
      setReload((n) => n + 1);
    } finally {
      setRunning(false);
    }
  }

  const shown = offset + jobs.length;
  const categoryLabel = (id: string) => categories.find((c) => c.id === id)?.label ?? id;

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>Job Search Copilot</h1>
          <div className="muted small">
            Review queue — best fit first, weighted toward preferred roles
          </div>
        </div>
        <button onClick={runFetch} disabled={running}>
          {running ? "Updating…" : "Update"}
        </button>
      </header>

      {note && (
        <p className="small muted" style={{ marginBottom: 16 }}>
          {note}
        </p>
      )}

      <div className="controls">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, company, location"
          aria-label="Search jobs"
          style={{ minWidth: 240 }}
        />
        <label className="field">
          Min fit
          <select value={minFit} onChange={(e) => changeFilter(setMinFit, e.target.value)}>
            <option value="">any</option>
            <option value="25">25+</option>
            <option value="50">50+</option>
            <option value="75">75+</option>
          </select>
        </label>
        <label className="field">
          Role
          <select
            value={category}
            onChange={(e) => changeFilter(setCategory, e.target.value)}
            title="Filter to one role family. The default shows every family, ranked together."
          >
            <option value="">all roles</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Location
          <select
            value={locations}
            onChange={(e) => changeFilter(setLocations, e.target.value)}
            title="“My countries” hides postings outside the countries in profile.toml. Nothing is deleted — switch to “Everywhere” to see them."
          >
            <option value="mine">My countries</option>
            <option value="all">Everywhere</option>
          </select>
        </label>
        <label className="field">
          Seen
          <select
            value={maxAgeDays}
            onChange={(e) => changeFilter(setMaxAgeDays, e.target.value)}
            title="Hide listings a source has not returned recently. Search feeds (JSearch, RemoteOK, Adzuna, USAJobs) are never auto-delisted, so a dead posting stays open in the queue until it ages out here."
          >
            {/* No option text may contain the word "Seen": the e2e page object
                locates a filter with `hasText`, which is a case-insensitive
                substring match over the whole label INCLUDING its options — so
                a "seen today" option satisfied the "Seen" label assertion even
                after the label itself was renamed. */}
            <option value="">any age</option>
            <option value="1">today</option>
            <option value="3">last 3 days</option>
            <option value="7">last 7 days</option>
            <option value="14">last 14 days</option>
            <option value="30">last 30 days</option>
          </select>
        </label>
        <label className="field">
          Status
          <select value={status} onChange={(e) => changeFilter(setStatus, e.target.value)}>
            {APPLICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value="">all</option>
          </select>
        </label>
        <span className="spacer" />
        <span className="muted small">
          {total === 0 ? "0 jobs" : `${offset + 1}–${shown} of ${total}`}
        </span>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : jobs.length === 0 ? (
        <p className="muted">
          No jobs match. Try clearing the search, lowering the min-fit filter, widening Location or
          Seen, or clicking “Update” to pull the latest listings.
        </p>
      ) : (
        <>
          {jobs.map((j) => (
            <Link key={j.id} href={`/jobs/${j.id}`} className="card">
              <div className="row">
                <span
                  className={`badge ${fitClass(j.fit?.score)}`}
                  title={
                    j.fit?.model === FALLBACK_MODEL
                      ? "Provisional: the LLM call failed, so this is a keyword prefilter score."
                      : undefined
                  }
                >
                  {j.fit?.score ?? "—"}
                  {/* A fallback row sorts like a real result but is keyword
                      noise. Unmarked, a failed scoring run is invisible here. */}
                  {j.fit?.model === FALLBACK_MODEL && "*"}
                </span>
                <div style={{ flex: 1 }}>
                  <h3>{j.title}</h3>
                  <div className="meta">
                    {j.company} · {j.location}
                    {j.remote ? " · remote" : ""} · {j.source}
                    {j.compensation ? ` · ${j.compensation}` : ""}
                  </div>
                </div>
                {/* Without this the ranking looks broken: a 75 sitting above an
                    80 only makes sense once you can see which family each is in. */}
                <span className={`pill cat-${j.category}`}>{categoryLabel(j.category)}</span>
                {j.status !== "new" && <span className={`pill ${j.status}`}>{j.status}</span>}
                {j.hasResume && <span className="pill">résumé ✓</span>}
                {j.status !== "skipped" && (
                  <button
                    className="danger"
                    title="Not interested — hide this job from the queue"
                    onClick={(e) => {
                      // Inside a <Link>: preventDefault stops the navigation,
                      // stopPropagation stops the card's own click handling.
                      e.preventDefault();
                      e.stopPropagation();
                      void dismiss(j);
                    }}
                  >
                    Not interested
                  </button>
                )}
              </div>
              {j.fit?.reason && <div className="reason muted">{j.fit.reason}</div>}
            </Link>
          ))}

          <div className="row" style={{ marginTop: 16 }}>
            <button
              className="ghost"
              onClick={() => {
                setLoading(true);
                setOffset(Math.max(0, offset - PAGE_SIZE));
              }}
              disabled={offset === 0}
            >
              ← Previous
            </button>
            <button
              className="ghost"
              onClick={() => {
                setLoading(true);
                setOffset(offset + PAGE_SIZE);
              }}
              disabled={shown >= total}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
