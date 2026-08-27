// canonical.ts — canonical JSON for the quilt ledger hash chain.
//
// The quilt cell ledger pins its hash preimage as *canonical JSON*
// (quilt-rust docs/cell-ledger.md §4): compact, object keys sorted by
// UTF-8 byte order, integers rendered as integers, floats in Rust's
// shortest-round-trip form (serde_json / ryū — `40.0` stays `40.0`).
//
// JavaScript's JSON.parse erases the int/float distinction (`40.0`
// parses to 40 and re-renders as "40"), which is the documented
// porting hazard. This module solves it with a number-preserving
// parser: numbers are kept as their raw lexeme and re-validated, so a
// journal emitted by serde_json re-canonicalizes bit-for-bit.

/** A JSON number, preserved as its original lexeme. */
export class RawNumber {
  constructor(readonly raw: string) {}
}

/** Parsed JSON value: standard JSON values with RawNumber for numbers. */
export type Json =
  | null
  | boolean
  | RawNumber
  | string
  | Json[]
  | { [key: string]: Json };

// ---------------------------------------------------------------------------
// Number-preserving parse
// ---------------------------------------------------------------------------

/**
 * Parse JSON text into a structure that preserves number lexemes.
 * Throws on trailing garbage, invalid escapes, control characters in
 * strings — strict JSON only.
 */
export function parsePreserving(text: string): Json {
  let i = 0;
  const n = text.length;

  const ws = (): void => {
    while (i < n) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  };

  const value = (): Json => {
    ws();
    if (i >= n) throw err("unexpected end of input");
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') return stringNode();
    if (c === "t") return literal("true", true);
    if (c === "f") return literal("false", false);
    if (c === "n") return literal("null", null);
    return number();
  };

  const err = (msg: string): Error => new Error(`JSON parse error at offset ${i}: ${msg}`);

  const literal = (word: string, v: Json): Json => {
    if (text.slice(i, i + word.length) !== word) throw err(`expected ${word}`);
    i += word.length;
    return v;
  };

  const object = (): Json => {
    i++; // {
    const out: { [key: string]: Json } = {};
    ws();
    if (text[i] === "}") { i++; return out; }
    for (;;) {
      ws();
      if (text[i] !== '"') throw err("expected object key");
      const key = stringNode() as string;
      ws();
      if (text[i] !== ":") throw err("expected ':'");
      i++;
      out[key] = value();
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return out; }
      throw err("expected ',' or '}'");
    }
  };

  const array = (): Json => {
    i++; // [
    const out: Json[] = [];
    ws();
    if (text[i] === "]") { i++; return out; }
    for (;;) {
      out.push(value());
      ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return out; }
      throw err("expected ',' or ']'");
    }
  };

  const stringNode = (): Json | string => {
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= n) throw err("unterminated string");
      const c = text[i];
      if (c === '"') { i++; return out; }
      if (c === "\\") {
        const e = text[i + 1];
        if (e === undefined) throw err("bad escape");
        if (e === '"' || e === "\\" || e === "/") { out += e; i += 2; continue; }
        if (e === "b") { out += "\b"; i += 2; continue; }
        if (e === "f") { out += "\f"; i += 2; continue; }
        if (e === "n") { out += "\n"; i += 2; continue; }
        if (e === "r") { out += "\r"; i += 2; continue; }
        if (e === "t") { out += "\t"; i += 2; continue; }
        if (e === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw err("bad \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        throw err(`invalid escape \\${e}`);
      }
      if (c.charCodeAt(0) < 0x20) throw err("control character in string");
      out += c;
      i++;
    }
  };

  const number = (): RawNumber => {
    const start = i;
    if (text[i] === "-") i++;
    if (text[i] === "0") i++;
    else if (text[i] >= "1" && text[i] <= "9") { while (i < n && text[i] >= "0" && text[i] <= "9") i++; }
    else throw err("invalid number");
    if (text[i] === ".") {
      i++;
      const d0 = i;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
      if (i === d0) throw err("number needs digits after '.'");
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      const d0 = i;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
      if (i === d0) throw err("exponent needs digits");
    }
    return new RawNumber(text.slice(start, i));
  };

  const v = value();
  ws();
  if (i !== n) throw err("trailing characters after JSON value");
  return v;
}

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

/**
 * Normalize a number lexeme to serde_json / ryū rendering:
 * - integer lexemes (no '.', 'e', 'E') pass through (`-0` → `0`);
 * - float lexemes re-render as ECMAScript's shortest round-trip with the
 *   float marker kept (`40` from `4e1`-style floats stays `40.0`).
 * Floats outside [1e-5, 1e16) throw: their ryū rendering uses an
 * exponent style this port does not reproduce, and silently hashing a
 * different preimage than Rust would be a lie. (Real ledger values —
 * timestamps, sensor readings, distances — never hit this range.)
 */
export function canonicalNumber(lexeme: string): string {
  if (/^-?\d+$/.test(lexeme)) return lexeme === "-0" ? "0" : lexeme;
  const f = parseFloat(lexeme);
  if (!Number.isFinite(f)) throw new Error(`non-finite number: ${lexeme}`);
  const abs = Math.abs(f);
  if (abs !== 0 && (abs < 1e-5 || abs >= 1e16)) {
    throw new Error(
      `float ${lexeme} outside canonical normalization range [1e-5, 1e16); ` +
      `re-serialize the journal with a serde_json-compatible writer`,
    );
  }
  let s = f.toString(); // shortest round-trip digits (same digits ryū picks)
  if (s.includes("e")) {
    // Only reachable within the range guard for exotic lexemes like
    // 9.999999999999999e15. Expand to plain decimal.
    const [mant, exp] = s.split("e");
    const e = parseInt(exp, 10);
    const neg = mant.startsWith("-");
    const digits = (neg ? mant.slice(1) : mant).replace(".", "");
    const point = (neg ? mant.slice(1) : mant).indexOf(".") === -1
      ? digits.length
      : (neg ? mant.slice(1) : mant).indexOf(".");
    const newPoint = point + e;
    let plain: string;
    if (newPoint <= 0) plain = "0." + "0".repeat(-newPoint) + digits;
    else if (newPoint >= digits.length) plain = digits + "0".repeat(newPoint - digits.length) + ".0";
    else plain = digits.slice(0, newPoint) + "." + digits.slice(newPoint);
    s = (neg ? "-" : "") + plain;
  }
  if (!s.includes(".")) s += ".0"; // keep the float marker, like ryū
  return s;
}

const encoder = new TextEncoder();

/** Compare two strings by UTF-8 byte order (canonical key order). */
function byteCompare(a: string, b: string): number {
  const ba = encoder.encode(a), bb = encoder.encode(b);
  const len = Math.min(ba.length, bb.length);
  for (let i = 0; i < len; i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

/**
 * Canonical JSON: compact, keys sorted by UTF-8 byte order, numbers in
 * serde_json / ryū form. String escaping matches serde_json's default
 * table (which equals JSON.stringify's for all valid strings).
 */
export function canonicalJson(v: Json): string {
  const out: string[] = [];
  const write = (v: Json): void => {
    if (v === null) { out.push("null"); return; }
    if (typeof v === "boolean") { out.push(v ? "true" : "false"); return; }
    if (v instanceof RawNumber) { out.push(canonicalNumber(v.raw)); return; }
    if (typeof v === "string") { out.push(JSON.stringify(v)); return; }
    if (Array.isArray(v)) {
      out.push("[");
      for (let i = 0; i < v.length; i++) {
        if (i > 0) out.push(",");
        write(v[i]);
      }
      out.push("]");
      return;
    }
    const keys = Object.keys(v).sort(byteCompare);
    out.push("{");
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out.push(",");
      out.push(JSON.stringify(keys[i]), ":");
      write(v[keys[i]]);
    }
    out.push("}");
  };
  write(v);
  return out.join("");
}
