import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { cleanField, decodeEntities, htmlToText, repairMojibake } from "../../lib/html";

describe("decodeEntities", () => {
  it("decodes named, decimal, and hex entities", () => {
    assert.equal(decodeEntities("a &amp; b"), "a & b");
    assert.equal(decodeEntities("&#72;&#105;"), "Hi");
    assert.equal(decodeEntities("&#x48;&#x69;"), "Hi");
  });

  it("leaves unknown entities alone rather than eating them", () => {
    assert.equal(decodeEntities("&bogus;"), "&bogus;");
  });

  it("decodes exactly one level", () => {
    // The property htmlToText's two-pass design depends on.
    assert.equal(decodeEntities("&amp;amp;"), "&amp;");
  });
});

describe("htmlToText", () => {
  it("decodes entities before stripping tags", () => {
    assert.equal(htmlToText("&lt;p&gt;Hello&lt;/p&gt;"), "Hello");
  });

  it("strips real HTML too", () => {
    assert.equal(htmlToText("<p>Hello</p>"), "Hello");
  });

  it("resolves entities inside entity-encoded HTML (regression)", () => {
    // Greenhouse ships HTML that was entity-encoded a second time, so the inner
    // "&amp;" arrives as "&amp;amp;". A single decode pass left a literal
    // "&amp;" in the stored description on 668 of 1513 open rows (2026-08-25).
    const raw = "&lt;p&gt;Sage &amp;amp; Wix&amp;nbsp;rely on it&lt;/p&gt;";
    const out = htmlToText(raw);
    assert.equal(out, "Sage & Wix rely on it");
    assert.ok(!out.includes("&amp;"), "no residual entity");
    assert.ok(!out.includes("&nbsp;"), "no residual nbsp");
  });

  it("does not let a decoded '<' swallow following text as a tag", () => {
    // Why the second decode runs AFTER tag stripping: decoding twice up front
    // would turn this into "if x < 5 and y > 3", and the tag regex would then
    // eat "< 5 and y >".
    const out = htmlToText("&lt;p&gt;if x &amp;lt; 5 and y &amp;gt; 3&lt;/p&gt;");
    assert.equal(out, "if x < 5 and y > 3");
  });

  it("turns block ends into newlines and list items into bullets", () => {
    assert.equal(htmlToText("<ul><li>one</li><li>two</li></ul>"), "• one\n• two");
    assert.equal(htmlToText("a<br>b"), "a\nb");
  });

  it("collapses runaway whitespace", () => {
    assert.equal(htmlToText("<p>a</p>\n\n\n\n<p>b</p>"), "a\n\nb");
  });
});

describe("repairMojibake", () => {
  it("repairs UTF-8 that was decoded as Latin-1", () => {
    assert.equal(repairMojibake("Universidad CatÃ³lica"), "Universidad Católica");
    assert.equal(repairMojibake("GEA PerÃº"), "GEA Perú");
  });

  it("leaves genuine Latin-1 text untouched", () => {
    // A real accented word does not put a continuation byte after its accent.
    assert.equal(repairMojibake("Café"), "Café");
    assert.equal(repairMojibake("naïve"), "naïve");
  });

  it("is a no-op on plain ASCII", () => {
    assert.equal(repairMojibake("Site Reliability Engineer"), "Site Reliability Engineer");
  });
});

describe("cleanField", () => {
  it("decodes and normalizes short fields", () => {
    // RemoteOK really does send these, and they were being hashed into the
    // dedup id encoded, so the same employer failed to collapse across sources.
    assert.equal(cleanField("H&amp;M"), "H&M");
    assert.equal(cleanField("  Larsen &amp;  Toubro  "), "Larsen & Toubro");
  });
});
