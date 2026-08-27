// sha256.test.ts — NIST vectors + cross-check against node:crypto.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex, sha256HexStr } from "../dist/sha256.js";

test("sha256: NIST/FIPS vectors", () => {
  assert.equal(sha256HexStr(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256HexStr("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256HexStr("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("sha256: multi-block input (exactly 64 bytes and beyond)", () => {
  const exact64 = "a".repeat(64);
  assert.equal(
    sha256HexStr(exact64),
    "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
  );
  // cross-check anything node:crypto agrees with
  for (const s of ["", "x", "hello world", "a".repeat(55), "a".repeat(56), "a".repeat(200), "z".repeat(1000)]) {
    assert.equal(sha256HexStr(s), createHash("sha256").update(s).digest("hex"));
  }
});

test("sha256: non-ASCII UTF-8 bytes", () => {
  for (const s of ["høll", "boat ⛵", "日本語", "emoji 🚤"]) {
    assert.equal(sha256HexStr(s), createHash("sha256").update(s, "utf8").digest("hex"));
  }
});

test("sha256: byte-array input matches string input", () => {
  const bytes = new TextEncoder().encode("merkle mesh");
  assert.equal(sha256Hex(bytes), sha256HexStr("merkle mesh"));
});
