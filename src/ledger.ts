// ledger.ts — quilt cell-ledger journals: load, verify, hash.
//
// A journal is JSONL. Line 1 is a header:
//   { "kind": "quilt-cell-ledger-journal/1", "cell_id": ..., "genesis": ...,
//     "genesis_ts": ..., "entries": N, "chain_hash": <64-hex> }
// Each following line is one quilt `LedgerEntry`, exactly as serde emits
// it (field order does not matter — hashing runs over canonical JSON):
//   { seq, ts, input:{side,value,ts}, output:{side,value,ts},
//     provenance:{origin,caller?,trace?}, delta:{before,after,changed,magnitude},
//     expected?, imbalance?, prev_hash, hash }
//
// The chain rules are a faithful port of quilt-core
// `packages/core/src/ledger.rs`:
//   seal(e)            = sha256_hex(canonical(e minus hash))
//   genesis_commit     = sha256_hex(canonical({kind:"quilt-cell-ledger/1",
//                          cell_id, genesis, genesis_ts}))
//   chain_hash         = head.hash, or the genesis commit when empty
//   verify             = walk entries; prev-link from the genesis commit;
//                        recompute every seal.

import { canonicalJson, parsePreserving, type Json, RawNumber } from "./canonical.js";
import { sha256HexStr } from "./sha256.js";

export const JOURNAL_KIND = "quilt-cell-ledger-journal/1";
export const GENESIS_KIND = "quilt-cell-ledger/1";

export interface LedgerHeader {
  kind: string;
  cellId: string;
  genesis: Json;
  genesisTs: Json; // RawNumber | null
  entries: number;
  chainHash: string;
}

export interface LedgerEntry {
  seq: number;
  ts: number;
  input: Json;
  output: Json;
  provenance: Json;
  delta: Json;
  expected: Json | undefined;
  imbalance: Json | undefined;
  prevHash: string;
  hash: string;
  /** The canonical JSON of the entry body (everything except `hash`). */
  canonicalBody: string;
}

export interface Journal {
  /** Source path, when loaded from disk. */
  path?: string;
  header: LedgerHeader;
  entries: LedgerEntry[];
}

export class JournalError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "JournalError";
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const num = (v: Json, what: string): number => {
  if (v instanceof RawNumber && /^-?\d+$/.test(v.raw)) return parseInt(v.raw, 10);
  throw new JournalError(`${what} must be an integer, got ${JSON.stringify(String(v instanceof RawNumber ? v.raw : v))}`);
};

const str = (v: Json, what: string): string => {
  if (typeof v === "string") return v;
  throw new JournalError(`${what} must be a string`);
};

const obj = (v: Json, what: string): { [k: string]: Json } => {
  if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof RawNumber)) return v;
  throw new JournalError(`${what} must be an object`);
};

/** Parse one journal from JSONL text. */
export function parseJournal(text: string, path?: string): Journal {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new JournalError("empty journal", path);

  const headerV = parsePreserving(lines[0]);
  const headerO = obj(headerV, "journal header");
  const kind = str(field(headerO, "kind"), "header.kind");
  if (kind !== JOURNAL_KIND) {
    throw new JournalError(`unknown journal kind ${JSON.stringify(kind)} (expected ${JOURNAL_KIND})`, path);
  }
  const header: LedgerHeader = {
    kind,
    cellId: str(field(headerO, "cell_id"), "header.cell_id"),
    genesis: fieldOr(headerO, "genesis", null),
    genesisTs: fieldOr(headerO, "genesis_ts", null),
    entries: num(field(headerO, "entries"), "header.entries"),
    chainHash: str(field(headerO, "chain_hash"), "header.chain_hash"),
  };
  if (!/^[0-9a-f]{64}$/.test(header.chainHash)) {
    throw new JournalError("header.chain_hash must be 64 lowercase hex chars", path);
  }

  const entries: LedgerEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const e = parsePreserving(lines[i]);
    const eo = obj(e, `entry line ${i + 1}`);
    entries.push(parseEntry(eo, i + 1, path));
  }
  if (entries.length !== header.entries) {
    throw new JournalError(
      `header says ${header.entries} entries but journal carries ${entries.length}`,
      path,
    );
  }
  return { path, header, entries };
}

function field(o: { [k: string]: Json }, key: string): Json {
  const v = o[key];
  if (v === undefined) throw new JournalError(`missing field ${JSON.stringify(key)}`);
  return v;
}

function fieldOr(o: { [k: string]: Json }, key: string, dflt: Json): Json {
  const v = o[key];
  return v === undefined ? dflt : v;
}

function parseEntry(eo: { [k: string]: Json }, line: number, path?: string): LedgerEntry {
  const must = (key: string): Json => {
    const v = eo[key];
    if (v === undefined) throw new JournalError(`entry line ${line}: missing field ${JSON.stringify(key)}`, path);
    return v;
  };
  // The canonical body is the entry minus `hash` — computed on the raw
  // structure so key order in the file never matters.
  const body: { [k: string]: Json } = {};
  for (const k of Object.keys(eo)) if (k !== "hash") body[k] = eo[k];
  return {
    seq: num(must("seq"), `entry line ${line} seq`),
    ts: num(must("ts"), `entry line ${line} ts`),
    input: must("input"),
    output: must("output"),
    provenance: must("provenance"),
    delta: must("delta"),
    expected: eo["expected"],
    imbalance: eo["imbalance"],
    prevHash: str(must("prev_hash"), `entry line ${line} prev_hash`),
    hash: str(must("hash"), `entry line ${line} hash`),
    canonicalBody: canonicalJson(body),
  };
}

/** Load a journal file from disk. */
export async function loadJournal(path: string): Promise<Journal> {
  const text = await (await import("node:fs/promises")).readFile(path, "utf8");
  return parseJournal(text, path);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface ChainAudit {
  /** Number of entries whose seals were recomputed. */
  verified: number;
  /** True when every prev-link and every seal checks out. */
  intact: boolean;
  /** Sequence number of the first entry that failed, if any. */
  firstBreak: number | null;
  /** First failure reason, if any. */
  reason: string | null;
}

/** The genesis commit — chain root of an empty ledger (ports ledger.rs). */
export function genesisCommit(header: LedgerHeader): string {
  return sha256HexStr(
    canonicalJson({
      kind: GENESIS_KIND,
      cell_id: header.cellId,
      genesis: header.genesis,
      genesis_ts: header.genesisTs,
    }),
  );
}

/** Recompute every seal and prev-link (ports `verify_chain`). */
export function verifyChain(journal: Journal): ChainAudit {
  let expectedPrev = genesisCommit(journal.header);
  for (const e of journal.entries) {
    if (e.prevHash !== expectedPrev) {
      return {
        verified: e.seq - 1,
        intact: false,
        firstBreak: e.seq,
        reason: `prev_hash mismatch at seq ${e.seq}: entry says ${e.prevHash}, chain expects ${expectedPrev}`,
      };
    }
    const seal = sha256HexStr(e.canonicalBody);
    if (e.hash !== seal) {
      return {
        verified: e.seq - 1,
        intact: false,
        firstBreak: e.seq,
        reason: `seal mismatch at seq ${e.seq}: entry says ${e.hash}, body hashes to ${seal}`,
      };
    }
    expectedPrev = e.hash;
  }
  return { verified: journal.entries.length, intact: true, firstBreak: null, reason: null };
}

/** The chain hash: head seal, or the genesis commit when empty. */
export function chainHash(journal: Journal): string {
  const head = journal.entries[journal.entries.length - 1];
  return head ? head.hash : genesisCommit(journal.header);
}

/**
 * Full check: chain intact AND header metadata agrees (cell_id bound
 * into the genesis commit, chain_hash up to date, entry count right —
 * the count is validated at parse time).
 */
export function verifyJournal(journal: Journal): ChainAudit & { headerOk: boolean } {
  const audit = verifyChain(journal);
  const expected = chainHash(journal);
  return {
    ...audit,
    headerOk: audit.intact && expected === journal.header.chainHash,
  };
}
