import { expect, test } from "@playwright/test";
import { QueuePage } from "./pages/queue.page";
import { FIXTURE } from "./seed";

// The review queue. Default filters are minFit=50 / status=new / locations=mine,
// so the two high-fit fixtures are on screen and the low-fit one is not.

test("renders the queue instead of hanging on Loading", async ({ page }) => {
  const queue = new QueuePage(page);
  await queue.goto();

  // The regression this suite exists for. The page fetched its data, rendered
  // nothing, and sat on "Loading…" until something bumped a real effect
  // dependency — the search-debounce effect's mount run set the flag back to
  // true 250ms after load while `q` and `offset` kept their values, so the load
  // effect never re-ran to clear it.
  await expect(queue.heading).toBeVisible();
  await expect(queue.jobTitle(FIXTURE.tailored.title)).toBeVisible();

  // settle() waits past the debounce. Without it this spec asserts at ~140ms,
  // beats the 250ms timer, and passes against a deliberately re-broken build.
  await queue.settle();
  await expect(queue.loading).toHaveCount(0);
  await expect(queue.jobTitle(FIXTURE.tailored.title)).toBeVisible();
});

test("renders a card per job with its score, company and location", async ({ page }) => {
  const queue = new QueuePage(page);
  await queue.goto();
  await expect(queue.jobTitle(FIXTURE.tailored.title)).toBeVisible();

  const card = queue.card(FIXTURE.tailored.title);
  await expect(queue.badge(FIXTURE.tailored.title)).toHaveText("88");
  await expect(card).toContainText(FIXTURE.tailored.company);
  await expect(card).toContainText(FIXTURE.tailored.location);
  await expect(queue.resumePill(FIXTURE.tailored.title)).toBeVisible();

  // The second high-fit job is present, scored differently, and has no résumé.
  await expect(queue.badge(FIXTURE.untailored.title)).toHaveText("74");
  await expect(queue.resumePill(FIXTURE.untailored.title)).toHaveCount(0);
});

test("the filter controls render", async ({ page }) => {
  const queue = new QueuePage(page);
  await queue.goto();
  await expect(queue.jobTitle(FIXTURE.tailored.title)).toBeVisible();

  await expect(queue.searchBox).toBeVisible();
  for (const label of ["Min fit", "Role", "Location", "Seen", "Status"]) {
    await expect(queue.filter(label)).toBeVisible();
  }
  await expect(queue.updateButton).toBeVisible();
});

test("min-fit filter removes rows, and is not just hiding everything", async ({ page }) => {
  const queue = new QueuePage(page);
  await queue.goto();
  await expect(queue.jobTitle(FIXTURE.untailored.title)).toBeVisible();

  // 75+ must drop the 74 and keep the 88. Asserting BOTH directions is the
  // point: a filter that removed every row would satisfy the first check alone.
  await queue.setFilter("Min fit", "75");

  // settle() first: the list is cleared while it refetches, so the absence check
  // is satisfied by the transient empty state. Without this the spec passed
  // against a build where minFit was never sent at all — verified 2026-09-03.
  await queue.settle();
  await expect(queue.loading).toHaveCount(0);
  await expect(queue.jobTitle(FIXTURE.untailored.title)).toHaveCount(0);
  await expect(queue.jobTitle(FIXTURE.tailored.title)).toBeVisible();
});

test("search narrows the queue and clearing it restores the rows", async ({ page }) => {
  const queue = new QueuePage(page);
  await queue.goto();
  await expect(queue.jobTitle(FIXTURE.tailored.title)).toBeVisible();

  await queue.search(FIXTURE.untailored.company);
  // The visibility check alone proves nothing here — this row is on screen
  // before the search too. settle() past the debounce AND the refetch first.
  await queue.settle();
  await expect(queue.loading).toHaveCount(0);
  await expect(queue.jobTitle(FIXTURE.untailored.title)).toBeVisible();
  await expect(queue.jobTitle(FIXTURE.tailored.title)).toHaveCount(0);

  // Clearing must bring them back — the same debounce path as the mount bug,
  // exercised in the direction where `search` really does change back to "".
  await queue.search("");
  await queue.settle();
  await expect(queue.jobTitle(FIXTURE.tailored.title)).toBeVisible();
});

test("a search with no matches shows the empty state, not a spinner", async ({ page }) => {
  const queue = new QueuePage(page);
  await queue.goto();
  await expect(queue.jobTitle(FIXTURE.tailored.title)).toBeVisible();

  await queue.search("zzz-no-such-job-zzz");
  await expect(queue.emptyState).toBeVisible();
  await queue.settle();
  await expect(queue.loading).toHaveCount(0);
});

test("a card links through to the job detail page", async ({ page }) => {
  const queue = new QueuePage(page);
  await queue.goto();
  await queue.openJob(FIXTURE.tailored.title);

  await expect(page).toHaveURL(new RegExp(`/jobs/${FIXTURE.tailored.id}$`));
  await expect(queue.jobTitle(FIXTURE.tailored.title)).toBeVisible();
});

test("the Seen filter hides a stale listing and keeps a fresh one", async ({ page }) => {
  const queue = new QueuePage(page);
  await queue.goto();

  // Asserting BOTH directions, and both rows, is the point: with one row — or
  // with only the "hidden" half — a filter that removed everything would look
  // exactly as correct as one that works.
  await expect(queue.jobTitle(FIXTURE.freshlySeen.title)).toBeVisible();
  await expect(queue.jobTitle(FIXTURE.longStale.title)).toBeVisible();

  // settle() before EVERY absence check. A filter change clears the list while
  // it refetches, so `toHaveCount(0)` is satisfied by the transient empty state
  // — this spec passed against a build whose filter did nothing at all until the
  // wait was added. Same trap as the stuck-"Loading…" regression: an assertion
  // that beats the bug to the page is not a test.
  await queue.setFilter("Seen", "7");
  await queue.settle();
  await expect(queue.loading).toHaveCount(0);
  await expect(queue.jobTitle(FIXTURE.longStale.title)).toHaveCount(0);
  await expect(queue.jobTitle(FIXTURE.freshlySeen.title)).toBeVisible();

  // ...and back: the filter HIDES, it does not delete.
  await queue.setFilter("Seen", "");
  await queue.settle();
  await expect(queue.jobTitle(FIXTURE.longStale.title)).toBeVisible();
});
