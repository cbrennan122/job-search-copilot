// Pay formatting. Boards report compensation in wildly different shapes; the store
// keeps one short human-readable string because that is all the queue needs to
// help you triage. Nothing downstream parses these.

const fmt = (n: number, currency: string) => {
  const sym = { USD: "$", GBP: "£", EUR: "€", CAD: "CA$", AUD: "A$" }[currency] ?? "";
  const suffix = currency && !sym ? ` ${currency}` : "";
  return n >= 1000 ? `${sym}${Math.round(n / 1000)}K${suffix}` : `${sym}${Math.round(n)}${suffix}`;
};

/**
 * "$120K – $150K", "$120K+", or null when the board gave us nothing usable.
 * Zeroes mean "unset" on several boards (RemoteOK sends salary_min: 0), so they
 * are treated as absent rather than as a real $0 salary.
 */
export function formatSalaryRange(
  min: number | null | undefined,
  max: number | null | undefined,
  currency = "USD",
  period?: string,
): string | null {
  const lo = min && min > 0 ? min : null;
  const hi = max && max > 0 ? max : null;
  if (!lo && !hi) return null;
  const unit = period ? ` / ${period}` : "";
  if (lo && hi) return `${fmt(lo, currency)} – ${fmt(hi, currency)}${unit}`;
  return `${fmt((lo ?? hi)!, currency)}${lo ? "+" : " max"}${unit}`;
}
