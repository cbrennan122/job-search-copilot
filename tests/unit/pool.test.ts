import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mapPool } from "../../lib/pool";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("mapPool", () => {
  it("preserves input order regardless of completion order", async () => {
    // Deliberately inverted: item 0 is slowest, so a naive implementation that
    // pushed results as they settled would come back reversed.
    const out = await mapPool([50, 30, 10, 0], 4, async (delay, i) => {
      await tick(delay);
      return `${i}:${delay}`;
    });
    assert.deepEqual(out, ["0:50", "1:30", "2:10", "3:0"]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 30 }, (_, i) => i);

    await mapPool(items, 4, async () => {
      peak = Math.max(peak, ++inFlight);
      await tick(5);
      inFlight--;
    });

    assert.equal(peak, 4, `peak concurrency was ${peak}, expected exactly 4`);
  });

  it("keeps workers busy instead of running in fixed batches", async () => {
    // Deterministic, not wall-clock: with a shared cursor the second worker
    // finishes item 1 and immediately picks up item 2 while item 0 is still in
    // flight. Fixed batches of `limit` cannot start item 2 until item 0 settles,
    // which is the stall this design exists to avoid.
    const events: string[] = [];
    await mapPool([80, 1, 1, 1], 2, async (ms, i) => {
      events.push(`start${i}`);
      await tick(ms);
      events.push(`end${i}`);
    });
    assert.ok(
      events.indexOf("start2") < events.indexOf("end0"),
      `item 2 must start before item 0 finishes; got ${events.join(" ")}`,
    );
  });

  it("reports progress once per item, ending at the total", async () => {
    const seen: Array<[number, number]> = [];
    await mapPool([1, 2, 3, 4, 5], 2, async (n) => n, {
      onProgress: (done, total) => seen.push([done, total]),
    });
    assert.equal(seen.length, 5);
    assert.deepEqual(
      seen.map(([d]) => d),
      [1, 2, 3, 4, 5],
      "done count must advance monotonically",
    );
    assert.ok(seen.every(([, total]) => total === 5));
  });

  it("handles an empty list and a limit larger than the list", async () => {
    assert.deepEqual(await mapPool([], 4, async () => 1), []);
    assert.deepEqual(await mapPool([1, 2], 99, async (n) => n * 2), [2, 4]);
  });

  it("propagates an error from fn", async () => {
    await assert.rejects(
      () =>
        mapPool([1, 2, 3], 2, async (n) => {
          if (n === 2) throw new Error("boom");
          return n;
        }),
      /boom/,
    );
  });
});
