"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import {
  APPLICATION_STATUSES,
  type Application,
  type ApplicationStatus,
  type Artifact,
  type FitScore,
  type Job,
  type ResumeVersion,
} from "@/lib/types";
import type { VerifyReport } from "@/lib/verify";

interface Detail {
  job: Job;
  fit: FitScore | null;
  application: Application;
  resume: ResumeVersion | null;
  /** Which copy `resume.content` came from — see lib/resume-source.ts. */
  resumeSource: { from: "file" | "row"; diverged: boolean; warning: string | null } | null;
  artifacts: Artifact[];
}

export default function JobDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [d, setD] = useState<Detail | null>(null);
  const [tailoring, setTailoring] = useState(false);
  const [building, setBuilding] = useState(false);
  // What the last download actually rendered, from the response's own header —
  // otherwise the route computes "which copy" and nothing ever reads it.
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Fabrication check on the résumé this page just generated. Kept in state
  // rather than derived from `resume`, because it describes one generation.
  const [verify, setVerify] = useState<VerifyReport | null>(null);
  // Same pattern as the queue page: a counter dependency instead of a
  // useCallback `load()`, which the react-hooks rule flags for setting state
  // synchronously inside the effect body.
  const [reload, setReload] = useState(0);

  // Local copies so the notes fields stay editable without a round trip per
  // keystroke; they are seeded from the server on each load.
  const [notes, setNotes] = useState("");
  const [contact, setContact] = useState("");
  const [compNotes, setCompNotes] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/jobs/${id}`);
      if (!res.ok || cancelled) return;
      const data = (await res.json()) as Detail;
      if (cancelled) return;
      setD(data);
      setNotes(data.application.notes ?? "");
      setContact(data.application.contact ?? "");
      setCompNotes(data.application.compNotes ?? "");
      setFollowUpAt(data.application.followUpAt?.slice(0, 10) ?? "");
    })();
    return () => {
      cancelled = true;
    };
  }, [id, reload]);

  async function patch(body: Record<string, unknown>) {
    await fetch("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: id, ...body }),
    });
    setReload((n) => n + 1);
  }

  async function saveTracking() {
    await patch({
      notes,
      contact,
      compNotes,
      // Empty input means "no follow-up", which must be null rather than "".
      followUpAt: followUpAt || null,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  /**
   * Download the .docx for this job. The route renders it, writes it to
   * resumes/ and records the artifact, so `setReload` afterwards is what makes
   * the new row show up under Generated files without a manual refresh.
   */
  async function downloadDocx() {
    setBuilding(true);
    setErr(null);
    try {
      const res = await fetch(`/api/jobs/${id}/docx`);
      if (!res.ok) {
        // The route answers errors as JSON; a failed download must not save a
        // .docx that is actually an error payload.
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setErr(data.error ?? `HTTP ${res.status}`);
        return;
      }
      // Percent-encoded at the route: a header value cannot carry the em dash
      // this message uses. See app/api/jobs/[id]/docx/route.ts.
      const raw = res.headers.get("x-resume-warning");
      const warning = raw ? decodeURIComponent(raw) : null;
      const from = res.headers.get("x-resume-source");
      setDownloaded(
        warning ??
          (from === "file-edited"
            ? "Downloaded the edited file on disk."
            : from === "file"
              ? "Downloaded the tailored file on disk."
              : from === "row"
                ? "Downloaded the résumé as originally tailored."
                : null),
      );
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        res.headers.get("content-disposition")?.match(/filename="(.+?)"/)?.[1] ?? "resume.docx";
      a.click();
      URL.revokeObjectURL(url);
      setReload((n) => n + 1);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBuilding(false);
    }
  }

  async function tailor() {
    setTailoring(true);
    setErr(null);
    try {
      const res = await fetch("/api/tailor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: id }),
      });
      const data = await res.json();
      if (data.error) setErr(data.error);
      setVerify(data.verification ?? null);
      setReload((n) => n + 1);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setTailoring(false);
    }
  }

  if (!d)
    return (
      <div className="wrap">
        <p className="muted">Loading…</p>
      </div>
    );
  const { job, fit, application, resume, resumeSource, artifacts } = d;
  const status = application.status ?? "new";

  return (
    <div className="wrap">
      <Link href="/" className="small">
        ← back to queue
      </Link>

      <header className="top" style={{ marginTop: 12 }}>
        <div>
          <h1>{job.title}</h1>
          <div className="muted">
            {job.company} · {job.location}
            {job.remote ? " · remote" : ""} · {job.source}
          </div>
          <div className="muted small">
            {job.compensation ? `${job.compensation} · ` : ""}
            {job.employmentType ? `${job.employmentType} · ` : ""}
            {job.department ?? ""}
          </div>
        </div>
        {fit && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{fit.score}</div>
            <div className="muted small">fit ({fit.model})</div>
          </div>
        )}
      </header>

      {fit?.reason && <p className="muted">{fit.reason}</p>}

      <div className="row" style={{ marginTop: 16 }}>
        <a href={job.url} target="_blank" rel="noreferrer">
          <button>Open application ↗</button>
        </a>
        <label className="field">
          Status
          <select
            value={status}
            onChange={(e) => patch({ status: e.target.value as ApplicationStatus })}
          >
            {APPLICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        {application.appliedAt && (
          <span className="muted small">applied {application.appliedAt.slice(0, 10)}</span>
        )}
      </div>

      <section>
        <h2>Tracking</h2>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <label className="field">
            Follow up on
            <input type="date" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 200 }}>
            Contact
            <input
              type="text"
              placeholder="recruiter name / email"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
            />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 200 }}>
            Comp notes
            <input
              type="text"
              placeholder="range discussed, equity, …"
              value={compNotes}
              onChange={(e) => setCompNotes(e.target.value)}
            />
          </label>
        </div>
        <label className="field" style={{ display: "block", marginTop: 10 }}>
          Notes
          <textarea
            rows={4}
            style={{ width: "100%" }}
            placeholder="Interview prep, who you spoke to, what they asked…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="ghost" onClick={saveTracking}>
            Save tracking
          </button>
          {saved && <span className="muted small">Saved.</span>}
        </div>
      </section>

      <section>
        <h2>Tailored résumé</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <button onClick={tailor} disabled={tailoring}>
            {tailoring ? "Tailoring…" : resume ? "Re-tailor" : "Tailor résumé for this job"}
          </button>
          {resume && (
            <>
              <button onClick={downloadDocx} disabled={building}>
                {building ? "Building…" : "Download .docx"}
              </button>
              <button
                className="ghost"
                onClick={() => navigator.clipboard.writeText(resume.content)}
              >
                Copy résumé
              </button>
            </>
          )}
          <span className="muted small">
            Always review before sending — it re-emphasizes your real resume, but check every line.
          </span>
        </div>
        {err && <p className="error">Error: {err}</p>}
        {verify && <VerifyNotice r={verify} />}
        {resumeSource?.from === "file" && resumeSource.diverged && (
          <p className="muted small">
            Showing the edited file on disk, not the résumé as originally tailored. Download .docx
            renders this same text.
          </p>
        )}
        {resumeSource?.warning && <p className="error">{resumeSource.warning}</p>}
        {downloaded && <p className="muted small">{downloaded}</p>}
        {resume && <pre className="resume">{resume.content}</pre>}
        {resume?.draftedAnswers && (
          <>
            <h2 style={{ marginTop: 20 }}>Drafted answers</h2>
            <p className="muted small">
              Working notes for you — these contain placeholders and salary posture, and must never
              go into the document you send.
            </p>
            <pre className="answers">{resume.draftedAnswers}</pre>
          </>
        )}
      </section>

      <section>
        <h2>Generated files</h2>
        {artifacts.length === 0 ? (
          <p className="muted small">
            Nothing recorded yet. Tailoring writes the Markdown to <code>resumes/markdown/</code>,
            and “Download .docx” writes the document to <code>resumes/</code>; both are logged here
            so “applied” can say what you attached.
          </p>
        ) : (
          <ul className="artifacts">
            {artifacts.map((a) => (
              <li key={a.id}>
                <span className="muted small">{a.createdAt.slice(0, 10)}</span>{" "}
                <strong>{a.kind}</strong> <code>{a.path}</code>
                {a.kind === "answers-md" && (
                  <span className="muted small"> — prep only, never sent</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Job description</h2>
        <div className="jd">{job.description || "(no description)"}</div>
      </section>
    </div>
  );
}

/**
 * The résumé this page generates is what gets sent to an employer, so an
 * unsupported claim has to be visible here — not only in the CLI's stderr.
 * "Checked nothing" is rendered as a warning too: a document with no headings,
 * dates or figures yields zero claims, and a tick there means nothing was read.
 */
function VerifyNotice({ r }: { r: VerifyReport }) {
  const bad = !r.ok || r.checked === 0;
  return (
    <div
      style={{
        border: `1px solid ${bad ? "#b45309" : "#15803d"}`,
        background: bad ? "#fffbeb" : "#f0fdf4",
        borderRadius: 6,
        padding: "8px 12px",
        margin: "10px 0",
        fontSize: 13,
      }}
    >
      {r.checked === 0 ? (
        <strong>Nothing checkable found — this is not a pass. Read every line yourself.</strong>
      ) : r.ok ? (
        <span>
          ✓ Checked {r.checked} employer/date/metric/skill claims against your master résumé — all
          supported.
        </span>
      ) : (
        <>
          <strong>
            {r.unsupported.length} of {r.checked} claims are not in your master résumé — check each
            before sending:
          </strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {r.unsupported.map((c) => (
              <li key={`${c.kind}:${c.value}`}>
                <code>{c.kind}</code> {c.value}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
