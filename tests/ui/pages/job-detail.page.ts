import type { Download, Locator, Page } from "@playwright/test";

/**
 * One job at `/jobs/<id>`.
 *
 * Same contract as QueuePage: locators and actions here, assertions in the spec.
 */
export class JobDetailPage {
  readonly header: Locator;
  readonly fitModel: Locator;
  readonly fitReason: Locator;
  readonly loading: Locator;
  readonly openApplication: Locator;
  readonly backLink: Locator;

  readonly tailorButton: Locator;
  readonly retailorButton: Locator;
  readonly downloadButton: Locator;
  readonly copyButton: Locator;

  readonly resumeBlock: Locator;
  readonly answersBlock: Locator;
  readonly generatedFiles: Locator;

  constructor(private readonly page: Page) {
    this.header = page.locator("header.top");
    this.fitModel = page.getByText(/fit \(claude-sonnet-5\)/);
    this.fitReason = page.getByText(/Fixture reason/);
    this.loading = page.getByText("Loading…");
    this.openApplication = page.getByRole("button", { name: "Open application ↗" });
    this.backLink = page.getByRole("link", { name: "← back to queue" });

    this.tailorButton = page.getByRole("button", { name: "Tailor résumé for this job" });
    this.retailorButton = page.getByRole("button", { name: "Re-tailor" });
    this.downloadButton = page.getByRole("button", { name: "Download .docx" });
    this.copyButton = page.getByRole("button", { name: "Copy résumé" });

    this.resumeBlock = page.locator("pre.resume");
    this.answersBlock = page.locator("pre.answers");
    this.generatedFiles = page.locator("section", { hasText: "Generated files" });
  }

  async goto(jobId: string): Promise<void> {
    await this.page.goto(`/jobs/${jobId}`);
  }

  heading(title: string): Locator {
    return this.page.getByRole("heading", { name: title });
  }

  section(name: string): Locator {
    return this.page.getByRole("heading", { name });
  }

  /** A tracking input by its visible label: "Follow up on", "Contact", … */
  trackingField(label: string): Locator {
    return this.page.locator("label.field", { hasText: label }).first();
  }

  get statusSelect(): Locator {
    return this.page.locator("label.field", { hasText: "Status" }).getByRole("combobox");
  }

  /** One row of the Generated files list, by artifact kind. */
  artifactRow(kind: string): Locator {
    return this.generatedFiles.locator("li", { hasText: kind });
  }

  /** Click Download .docx and hand back the browser download it triggers. */
  async downloadDocx(): Promise<Download> {
    const [download] = await Promise.all([
      this.page.waitForEvent("download"),
      this.downloadButton.click(),
    ]);
    return download;
  }

  /**
   * Stub `/api/tailor`. It spends an LLM call and needs a key, so the UI wiring
   * is exercised without the model — CI has no key by design.
   */
  async stubTailor(body: unknown): Promise<void> {
    await this.page.route("**/api/tailor", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      }),
    );
  }
}
