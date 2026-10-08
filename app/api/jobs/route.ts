import { NextRequest, NextResponse } from "next/server";
import { rankedCategories } from "@/lib/categories";
import { countJobs, listJobs, MAX_FILTER_DAYS, type ListOpts } from "@/lib/store";
import type { ApplicationStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function intParam(v: string | null, fallback: number): number {
  // Test for absence BEFORE converting. Number(null) and Number("") are both 0,
  // which is finite and >= 0, so an omitted ?limit= used to pass the guard as a
  // legitimate zero — yielding LIMIT 0, an empty `jobs` array, and a `total`
  // reporting the real count beside it.
  if (v == null || v.trim() === "") return fallback;
  const n = Number(v);
  // Integers only: a fractional LIMIT is not a meaningful page size.
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * An optional day-count filter: undefined for absent, empty OR malformed input.
 *
 * Malformed has to collapse to undefined rather than fall through as NaN.
 * buildWhere feeds this into `new Date(Date.now() - n * 86_400_000)`, and
 * `new Date(NaN).toISOString()` throws RangeError — so `?maxAgeDays=abc` took
 * down the whole queue with a 500 rather than being ignored.
 *
 * FINITE IS NOT ENOUGH. A Date more than ~1e8 days from the epoch throws the
 * same RangeError, so `?maxAgeDays=1e9` reproduced the original 500 exactly,
 * one input shape over — the first fix rejected the value that had been tried,
 * not the class. Anything past MAX_FILTER_DAYS means "no filter" in practice
 * and is ignored as malformed. buildWhere clamps as well, so a caller that
 * skips this cannot crash either.
 */
function optionalDays(v: string | null): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_FILTER_DAYS ? n : undefined;
}

export function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const minFit = p.get("minFit");

  // Paged and description-free. This route used to return every matching row
  // with its full JD attached — 9.6 MB for `?status=new` on a 1.6k-job database,
  // nearly all of it text the list view never renders.
  const opts: ListOpts = {
    minFit: minFit != null && minFit !== "" ? Number(minFit) : undefined,
    status: (p.get("status") || undefined) as ApplicationStatus | undefined,
    source: p.get("source") || undefined,
    category: p.get("category") || undefined,
    // Anything other than an explicit "all" means "my countries" — an absent or
    // misspelled param must not silently widen the queue back out to the world.
    locations: p.get("locations") === "all" ? "all" : "mine",
    q: p.get("q") || undefined,
    includeClosed: p.get("includeClosed") === "1",
    // "Seen within N days". The only handle on a stale SEARCH-feed listing:
    // jsearch/remoteok/adzuna/usajobs declare no scopes, so markDelisted can
    // never close one and `closedAt IS NULL` keeps it in the queue forever.
    maxAgeDays: optionalDays(p.get("maxAgeDays")),
    limit: Math.min(intParam(p.get("limit"), DEFAULT_LIMIT), MAX_LIMIT),
    offset: intParam(p.get("offset"), 0),
  };

  const jobs = listJobs(opts);
  // Count with the same filters but no paging, so the UI can page without
  // guessing whether another page exists.
  const total = countJobs({ ...opts, limit: undefined, offset: undefined });

  return NextResponse.json({
    jobs,
    total,
    limit: opts.limit,
    offset: opts.offset,
    // Shipped with every page so the filter always offers exactly the families
    // the server classifies by. Hardcoding the list in the client would let a
    // profile.toml edit produce a dropdown option that matches nothing, or hide
    // one that does. Ordered most-preferred first — the same weights that order
    // the queue itself.
    categories: rankedCategories().map((c) => ({ id: c.id, label: c.label })),
  });
}
