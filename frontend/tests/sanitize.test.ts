import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubContactDetails, toLineChunks, safeLine, hasContactDetails } from "../src/lib/face-to-face/sanitize";

test("removes phone numbers in common shapes", () => {
  for (const phone of ["(201) 555-0142", "201-555-0142", "201.555.0142", "+1 201 555 0142", "+233 24 123 4567", "+971-50-123-4567", "2015550142", "+44 (0)20 7946 0958"]) {
    const out = scrubContactDetails(`Call me on ${phone} any time`);
    assert.ok(!/\d{3,}/.test(out), `${phone} -> ${out}`);
  }
});

test("removes email, links and SSN-shaped numbers", () => {
  const out = scrubContactDetails("jane.doe@example.com | https://linkedin.com/in/jane | www.jane.dev | 123-45-6789");
  assert.ok(!out.includes("@") && !out.includes("linkedin") && !out.includes("jane.dev") && !out.includes("6789"), out);
});

test("keeps dates, years and metrics", () => {
  for (const keep of ["Nov 2024 - Present", "2019-2024", "2019 - 2024", "reduced incidents by 35%", "monitored 120 cameras across 3 sites", "CySA+ (2025)", "handled 1,200 alerts", "24/7 control room", "ISO 27001"]) {
    assert.equal(scrubContactDetails(keep), keep);
    assert.equal(hasContactDetails(keep), false);
  }
});

test("chunks fit the line limit and lose nothing", () => {
  const text = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} about security operations work.`).join(" ");
  const chunks = toLineChunks(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1900, String(c.length));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), text);
});

test("safeLine caps length", () => {
  assert.ok(safeLine("x".repeat(5000)).length <= 1900);
});
