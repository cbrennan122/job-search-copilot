import type { Locator, Page } from "@playwright/test";

/**
 * The review queue at `/`.
 *
 * Page objects own the selectors and the interactions; they deliberately own no
 * assertions. A page object that asserts hides WHAT a spec is checking behind a
 * method name, and the failure then reads as "checkQueue failed" instead of
 * naming the element that was missing. Specs read the locators and assert.
 */
export class QueuePage {
  readonly heading: Locator;
  readonly searchBox: Locator;
  readonly updateButton: Locator;
  readonly loading: Locator;
  readonly emptyState: Locator;
  readonly cards: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole("heading", { name: "Job Search Copilot" });
    this.searchBox = page.getByLabel("Search jobs");
    this.updateButton = page.getByRole("button", { name: "Update" });
    this.loading = page.getByText("Loading…");
    this.emptyState = page.getByText(/No jobs match/);
    this.cards = page.locator(".card");
  }

  async goto(): Promise<void> {
    await this.page.goto("/");
  }

  /** The card for one job, located by its title — the only stable handle a card has. */
  card(title: string): Locator {
    return this.page.locator(".card", { hasText: title });
  }

  /** A job's title as rendered inside its card, for presence/absence checks. */
  jobTitle(title: string): Locator {
    return this.page.getByRole("heading", { name: title });
  }

  /** The fit badge on a job's card. */
  badge(title: string): Locator {
    return this.card(title).locator(".badge");
  }

  /** The "résumé ✓" pill, present only when the job has a tailored version. */
  resumePill(title: string): Locator {
    return this.card(title).getByText("résumé ✓");
  }

  /** One of the labelled filter controls: "Min fit", "Role", "Location", "Seen", "Status". */
  filter(label: string): Locator {
    return this.page.locator("label.field", { hasText: label });
  }

  filterSelect(label: string): Locator {
    return this.filter(label).getByRole("combobox");
  }

  async setFilter(label: string, value: string): Promise<void> {
    await this.filterSelect(label).selectOption(value);
  }

  async search(text: string): Promise<void> {
    await this.searchBox.fill(text);
  }

  async openJob(title: string): Promise<void> {
    await this.card(title).click();
  }

  /**
   * Wait past the search debounce before asserting on `loading`.
   *
   * The stuck-"Loading…" bug was a TIMER: the debounce effect's mount run flipped
   * the flag back on 250ms after load, and no effect dependency changed to clear
   * it. A check that runs sooner races the bug and wins — the first version of
   * that spec passed against a deliberately re-broken build. This is the one
   * place a fixed wait is the correct tool rather than a smell.
   */
  async settle(): Promise<void> {
    await this.page.waitForTimeout(800);
  }
}
