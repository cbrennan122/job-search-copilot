import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { JobDetailPage } from "./pages/job-detail.page";
import { QueuePage } from "./pages/queue.page";
import { ANSWERS_MARKER, FIXTURE, RESUME_MARKER } from "./seed";

test("renders the job header, fit score and reason", async ({ page }) => {
  const detail = new JobDetailPage(page);
  await detail.goto(FIXTURE.tailored.id);

  await expect(detail.heading(FIXTURE.tailored.title)).toBeVisible();

  // Scoped to the header: the company name also appears in the job description
  // below, so an unscoped match is ambiguous rather than wrong.
  await expect(detail.header).toContainText(FIXTURE.tailored.company);
  await expect(detail.header).toContainText(FIXTURE.tailored.location);
  await expect(detail.header).toContainText("88");
  await expect(detail.fitModel).toBeVisible();
  await expect(detail.fitReason).toBeVisible();
  await expect(detail.loading).toHaveCount(0);
});

test("renders the tracking controls and the status select", async ({ page }) => {
  const detail = new JobDetailPage(page);
  await detail.goto(FIXTURE.tailored.id);
  await expect(detail.section("Tracking")).toBeVisible();

  for (const label of ["Follow up on", "Contact", "Comp notes", "Notes"]) {
    await expect(detail.trackingField(label)).toBeVisible();
  }
  await expect(detail.openApplication).toBeVisible();
  await expect(detail.statusSelect).toHaveValue("new");
});

test("renders the stored résumé and its drafted answers separately", async ({ page }) => {
  const detail = new JobDetailPage(page);
  await detail.goto(FIXTURE.tailored.id);

  await expect(detail.section("Tailored résumé")).toBeVisible();
  await expect(detail.resumeBlock).toContainText(RESUME_MARKER);

  // The two must stay visibly distinct — the answers carry placeholders and
  // salary posture and must never be mistaken for part of the document.
  await expect(detail.section("Drafted answers")).toBeVisible();
  await expect(detail.answersBlock).toContainText(ANSWERS_MARKER);
  await expect(detail.resumeBlock).not.toContainText(ANSWERS_MARKER);
});

test("Download .docx appears only once a résumé exists", async ({ page }) => {
  const detail = new JobDetailPage(page);

  await detail.goto(FIXTURE.untailored.id);
  await expect(detail.heading(FIXTURE.untailored.title)).toBeVisible();
  // Nothing tailored yet: offer tailoring, and do not offer a document.
  await expect(detail.tailorButton).toBeVisible();
  await expect(detail.downloadButton).toHaveCount(0);

  await detail.goto(FIXTURE.tailored.id);
  await expect(detail.retailorButton).toBeVisible();
  await expect(detail.downloadButton).toBeVisible();
  await expect(detail.copyButton).toBeVisible();
});

test("Download .docx actually delivers a Word document", async ({ page }) => {
  const detail = new JobDetailPage(page);
  await detail.goto(FIXTURE.tailored.id);
  await expect(detail.downloadButton).toBeVisible();

  const download = await detail.downloadDocx();
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
  expect(download.suggestedFilename()).toContain("Fixture-Labs");

  // Prove it is a real OPC package rather than a JSON error body wearing a
  // .docx name: every .docx is a zip, so it starts with "PK".
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const bytes = Buffer.concat(chunks);
  expect(bytes.length).toBeGreaterThan(2000);
  expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
});

test("Generated files lists artifacts and flags the prep-only one", async ({ page }) => {
  const detail = new JobDetailPage(page);
  await detail.goto(FIXTURE.tailored.id);

  await expect(detail.section("Generated files")).toBeVisible();
  await expect(detail.artifactRow("resume-md")).toBeVisible();
  await expect(detail.artifactRow("answers-md")).toBeVisible();

  // The tag must be on the answers row and ONLY there. Checking both sides is
  // what makes this a real assertion: a tag rendered on every row, or on none,
  // would pass a one-sided check.
  await expect(detail.artifactRow("answers-md")).toContainText("prep only, never sent");
  await expect(detail.artifactRow("resume-md")).not.toContainText("prep only, never sent");
});

test("Generated files explains itself when a job has none", async ({ page }) => {
  const detail = new JobDetailPage(page);
  await detail.goto(FIXTURE.untailored.id);
  await expect(detail.generatedFiles).toContainText("Nothing recorded yet");
});

test("tailoring surfaces the fabrication check", async ({ page }) => {
  const detail = new JobDetailPage(page);
  await detail.stubTailor({
    version: {
      id: "stub",
      jobId: FIXTURE.untailored.id,
      content: "# Connor Brennan\n\nstubbed résumé body\n",
      draftedAnswers: "",
      coverLetter: "",
      model: "claude-sonnet-5",
      createdAt: "2026-08-28T00:00:00.000Z",
    },
    verification: { ok: false, checked: 12, unsupported: [{ kind: "skill", value: "Rust" }] },
  });

  await detail.goto(FIXTURE.untailored.id);
  await detail.tailorButton.click();

  await expect(page.getByText(/1 of 12 claims are not in your master résumé/)).toBeVisible();
});

test("the back link returns to the queue", async ({ page }) => {
  const detail = new JobDetailPage(page);
  const queue = new QueuePage(page);
  await detail.goto(FIXTURE.tailored.id);

  await detail.backLink.click();
  await expect(queue.heading).toBeVisible();
});

// The download route writes the .docx into resumes/ exactly as the CLI does, so
// the run leaves a fixture file behind. Gitignored, but tests should not litter.
test.afterAll(() => {
  const stray = path.join(process.cwd(), "resumes", "Fixture-Labs-Staff-Platform-Engineer.docx");
  if (existsSync(stray)) rmSync(stray);
});
