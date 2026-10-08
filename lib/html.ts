// Minimal HTML -> plain text. Job-board descriptions arrive as HTML (often
// entity-ENCODED HTML, e.g. Greenhouse sends "&lt;p&gt;"). So we must decode
// entities FIRST, then strip the resulting tags. Good enough, not a full parser.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

/**
 * Decode HTML entities. Exported because short plain-text fields (job title,
 * company name) also arrive encoded — RemoteOK really does send "H&amp;M" and
 * "Larsen &amp; Toubro". Those were being stored raw AND hashed into the dedup
 * id, so the same employer could fail to collapse across sources.
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

/**
 * Repair UTF-8 that a source already mangled by decoding it as Latin-1.
 * RemoteOK ships rows like "Universidad CatÃ³lica" and "GEA PerÃº".
 *
 * Deliberately conservative: it only acts when the string contains a telltale
 * lead byte followed by a continuation-range byte AND the whole string then
 * round-trips as valid UTF-8. Text that is legitimately Latin-1 is left alone,
 * because a real accented word does not put a continuation byte after its accent.
 */
export function repairMojibake(s: string): string {
  // A UTF-8 lead byte followed by a continuation byte is the mojibake tell.
  if (!/[\u00C2\u00C3\u00D0\u00E2\u00F0][\u0080-\u00BF]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from(s, (ch) => {
      const c = ch.charCodeAt(0);
      if (c > 0xff) throw new Error("not latin-1 representable");
      return c;
    });
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return s; // not actually mojibake — leave it exactly as it came in
  }
}

/** Clean a short plain-text field (title, company) coming off a board. */
export function cleanField(s: string): string {
  return repairMojibake(decodeEntities(s)).replace(/\s+/g, " ").trim();
}

export function htmlToText(html: string): string {
  // Two decode passes, and the order matters.
  //
  // Greenhouse sends entity-ENCODED HTML — real HTML that was entity-encoded a
  // second time — so "<p>Sage &amp; Wix</p>" arrives as
  // "&lt;p&gt;Sage &amp;amp; Wix&lt;/p&gt;". One decode yields real HTML whose
  // own entities are still encoded, and stripping tags cannot touch those, which
  // is how literal "&amp;" and "&nbsp;" were reaching the database (668 of 1513
  // open Stripe/Greenhouse rows on 2026-08-25).
  //
  // Decoding twice up front would be wrong: a JD that says "if x &amp;lt; 5"
  // would become "if x < 5", and the tag stripper would then eat "< 5 ...>" as a
  // tag. Stripping between the passes means the second decode only ever sees
  // text, so a decoded "<" can no longer be mistaken for markup.
  const decoded = repairMojibake(decodeEntities(html));
  const stripped = decoded
    .replace(/<\s*(br|\/p|\/li|\/div|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\u2022 ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(stripped)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
