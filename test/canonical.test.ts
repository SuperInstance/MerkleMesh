// canonical.test.ts — the canonical JSON form pinned by quilt-rust
// docs/cell-ledger.md §4, including the pinned Rust unit-test vectors
// and the JS float hazard.
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, canonicalNumber, parsePreserving, RawNumber } from "../dist/canonical.js";

test("canonical: pinned Rust vector (docs/cell-ledger.md §4)", () => {
  const v = parsePreserving('{"b": 1, "a": [2.5, true, null, "x"]}');
  assert.equal(canonicalJson(v), '{"a":[2.5,true,null,"x"],"b":1}');
});

test("canonical: insertion order is irrelevant", () => {
  const v1 = parsePreserving('{"x":1,"y":2}');
  const v2 = parsePreserving('{"y":2,"x":1}');
  assert.equal(canonicalJson(v1), canonicalJson(v2));
});

test("canonical: the JS float hazard — 40.0 must stay 40.0", () => {
  const v = parsePreserving('{"genesis": 40.0, "ts": 1726243200000, "x": 2.5}');
  assert.equal(canonicalJson(v), '{"genesis":40.0,"ts":1726243200000,"x":2.5}');
});

test("canonical: JSON.parse would break the chain; parsePreserving does not", () => {
  const raw = '{"v": 85.0}';
  assert.notEqual(JSON.stringify(JSON.parse(raw)), canonicalJson(parsePreserving(raw)));
  assert.equal(canonicalJson(parsePreserving(raw)), '{"v":85.0}');
});

test("canonicalNumber: integers pass through", () => {
  assert.equal(canonicalNumber("0"), "0");
  assert.equal(canonicalNumber("-0"), "0"); // serde_json parses -0 as i64 0
  assert.equal(canonicalNumber("42"), "42");
  assert.equal(canonicalNumber("1726243200000"), "1726243200000");
});

test("canonicalNumber: floats keep the marker", () => {
  assert.equal(canonicalNumber("40.0"), "40.0");
  assert.equal(canonicalNumber("77.5"), "77.5");
  assert.equal(canonicalNumber("2.5"), "2.5");
  assert.equal(canonicalNumber("-1.5"), "-1.5");
  assert.equal(canonicalNumber("4e1"), "40.0");
  assert.equal(canonicalNumber("0.0"), "0.0");
});

test("canonicalNumber: floats outside the plain-decimal range refuse loudly", () => {
  assert.throws(() => canonicalNumber("1e16"));
  assert.throws(() => canonicalNumber("1e-6"));
});

test("canonical: nested structures, arrays, escapes", () => {
  const v = parsePreserving('{"z": [{"b": 1.0, "a": null}, "q\\"uote\\nline", -3.25]}');
  assert.equal(canonicalJson(v), '{"z":[{"a":null,"b":1.0},"q\\"uote\\nline",-3.25]}');
});

test("canonical: RawNumber hashes are decided by lexeme class, not value", () => {
  // 40 (integer) and 40.0 (float) are DIFFERENT canonical values.
  assert.notEqual(canonicalJson(new RawNumber("40")), canonicalJson(new RawNumber("40.0")));
});

test("parsePreserving: rejects malformed JSON", () => {
  assert.throws(() => parsePreserving('{"a":}'));
  assert.throws(() => parsePreserving("[1,2,"));
  assert.throws(() => parsePreserving("01")); // leading zero is invalid JSON
  assert.throws(() => parsePreserving('"\\x"')); // invalid escape
  assert.throws(() => parsePreserving("{} trailing"));
  assert.throws(() => parsePreserving("1.5e")); // exponent needs digits
});
