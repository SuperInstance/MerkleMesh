// mesh.ts — the fleet mesh: a Merkle tree over many quilt journals.
//
// Doctrine: a boat's cell ledger is its autobiography; the chain hash
// commits to everything that boat ever recorded. A fleet is many boats
// — and one question: "is THIS boat's journal included in the fleet's
// state as of root R?" The mesh answers it the classic way: build a
// Merkle tree whose leaves are per-journal commitments, keep the root,
// hand out inclusion proofs.
//
// Construction (pinned here, versioned in the manifest):
//   leaf_i   = sha256(canonical({
//                kind: "merklemesh/leaf/1",
//                cell_id, chain_hash, entries }))
//   node     = sha256(canonical({ kind: "merklemesh/node/1", left, right }))
//
// - Leaves are sorted by cell_id (UTF-8 byte order) for determinism:
//   the same set of journals always yields the same root, regardless
//   of directory iteration order.
// - Odd leaf counts duplicate the last node of each level (the
//   Bitcoin convention): the sibling of a lone node is itself.
// - Duplicate cell_ids are rejected: one leaf per boat.

import { canonicalJson, RawNumber, type Json } from "./canonical.js";
import { sha256HexStr } from "./sha256.js";
import { chainHash, verifyJournal, type Journal } from "./ledger.js";

export const MESH_KIND = "merklemesh/mesh/1";
export const PROOF_KIND = "merklemesh/proof/1";

export interface MeshLeaf {
  cell_id: string;
  chain_hash: string;
  entries: number;
  /** Commitment hash of this leaf. */
  leaf: string;
}

export interface MeshProofStep {
  /** The sibling's hash. */
  hash: string;
  /** Which side the sibling sits on, from the prover's perspective. */
  side: "left" | "right";
}

export interface MeshProof {
  kind: string;
  cell_id: string;
  chain_hash: string;
  leaf: string;
  /** Bottom-up sibling path from the leaf to the root. */
  siblings: MeshProofStep[];
  leaf_count: number;
  root: string;
}

export interface Mesh {
  kind: string;
  /** UTC milliseconds when the mesh was built (informational only). */
  built_at?: number;
  leaves: MeshLeaf[];
  root: string;
  /** How many journals failed verification and were excluded. */
  skipped: { path: string; reason: string }[];
}

function leafHash(leaf: Omit<MeshLeaf, "leaf">): string {
  return sha256HexStr(
    canonicalJson({
      kind: "merklemesh/leaf/1",
      cell_id: leaf.cell_id,
      chain_hash: leaf.chain_hash,
      entries: new RawNumber(String(leaf.entries)),
    }),
  );
}

function nodeHash(left: string, right: string): string {
  return sha256HexStr(canonicalJson({ kind: "merklemesh/node/1", left, right }));
}

/**
 * Build the full tree levels. levels[0] = leaves; each subsequent
 * level halves (odd → last node pairs with itself); the root is
 * levels[last][0].
 */
function buildLevels(leafHashes: string[]): string[][] {
  if (leafHashes.length === 0) throw new Error("cannot mesh an empty fleet");
  const levels: string[][] = [leafHashes];
  let level = leafHashes;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i];
      const r = i + 1 < level.length ? level[i + 1] : l;
      next.push(nodeHash(l, r));
    }
    levels.push(next);
    level = next;
  }
  return levels;
}

/** Build a Merkle mesh from verified journals. */
export function buildMesh(journals: Journal[], opts?: { builtAt?: number }): Mesh {
  if (journals.length === 0) throw new Error("cannot mesh an empty fleet");

  const sorted = [...journals].sort((a, b) =>
    a.header.cellId < b.header.cellId ? -1 : a.header.cellId > b.header.cellId ? 1 : 0,
  );

  const leaves: MeshLeaf[] = [];
  const skipped: Mesh["skipped"] = [];
  const accepted: { journal: Journal; leaf: MeshLeaf }[] = [];
  let lastId = "";
  for (const j of sorted) {
    const audit = verifyJournal(j);
    if (!audit.headerOk) {
      skipped.push({ path: j.path ?? j.header.cellId, reason: audit.reason ?? `header chain_hash mismatch (expected ${j.header.chainHash})` });
      continue;
    }
    if (j.header.cellId === lastId) {
      skipped.push({ path: j.path ?? j.header.cellId, reason: `duplicate cell_id ${JSON.stringify(j.header.cellId)}` });
      continue;
    }
    lastId = j.header.cellId;
    const base = {
      cell_id: j.header.cellId,
      chain_hash: chainHash(j),
      entries: j.entries.length,
    };
    const leaf: MeshLeaf = { ...base, leaf: leafHash(base) };
    leaves.push(leaf);
    accepted.push({ journal: j, leaf });
  }
  if (accepted.length === 0) throw new Error("no verifiable journals to mesh");

  const levels = buildLevels(leaves.map((l) => l.leaf));
  return {
    kind: MESH_KIND,
    ...(opts?.builtAt !== undefined ? { built_at: opts.builtAt } : {}),
    leaves,
    root: levels[levels.length - 1][0],
    skipped,
  };
}

/** Build an inclusion proof for the journal whose cell_id is `cellId`. */
export function proveMesh(mesh: Mesh, cellId: string): MeshProof {
  const idx = mesh.leaves.findIndex((l) => l.cell_id === cellId);
  if (idx === -1) throw new Error(`cell_id ${JSON.stringify(cellId)} is not in the mesh`);
  const levels = buildLevels(mesh.leaves.map((l) => l.leaf));

  const siblings: MeshProofStep[] = [];
  let i = idx;
  for (let lvl = 0; lvl < levels.length - 1; lvl++) {
    const level = levels[lvl];
    const sibIdx = i ^ 1;
    if (sibIdx < level.length) {
      siblings.push({ hash: level[sibIdx], side: sibIdx < i ? "left" : "right" });
    } else {
      // Lone node at this level: its sibling is itself (duplicate rule).
      siblings.push({ hash: level[i], side: "right" });
    }
    i = i >> 1;
  }
  const leaf = mesh.leaves[idx];
  return {
    kind: PROOF_KIND,
    cell_id: leaf.cell_id,
    chain_hash: leaf.chain_hash,
    leaf: leaf.leaf,
    siblings,
    leaf_count: mesh.leaves.length,
    root: mesh.root,
  };
}

/**
 * Verify an inclusion proof bottom-up: fold the sibling path from the
 * leaf commitment to a root; check the root matches. Callers should
 * ALSO verify the journal itself (chain intact, chain_hash == the one
 * in the proof) before trusting the leaf — `verifyInclusion` does the
 * full sequence.
 */
export function verifyProof(proof: MeshProof): boolean {
  let cur = proof.leaf;
  for (const s of proof.siblings) {
    cur = s.side === "left" ? nodeHash(s.hash, cur) : nodeHash(cur, s.hash);
  }
  return cur === proof.root;
}

/**
 * The full check a fleet auditor wants:
 * 1. the journal's own hash chain verifies and its chain_hash is current;
 * 2. that chain_hash is the one committed in the proof;
 * 3. the leaf commitment matches (cell_id, chain_hash, entries);
 * 4. the sibling path folds back to the claimed root.
 */
export function verifyInclusion(journal: Journal, proof: MeshProof, root?: string): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const audit = verifyJournal(journal);
  if (!audit.headerOk) reasons.push(audit.reason ?? "journal chain does not verify");
  const h = chainHash(journal);
  if (h !== proof.chain_hash) reasons.push(`proof commits to chain_hash ${proof.chain_hash}, journal is at ${h}`);
  const expectedLeaf = leafHash({
    cell_id: journal.header.cellId,
    chain_hash: h,
    entries: journal.entries.length,
  });
  if (expectedLeaf !== proof.leaf) reasons.push("leaf commitment mismatch");
  if (journal.header.cellId !== proof.cell_id) reasons.push("proof is for a different cell_id");
  const targetRoot = root ?? proof.root;
  if (!verifyProof({ ...proof, root: proof.root })) reasons.push("sibling path does not fold to the proof's root");
  if (proof.root !== targetRoot && reasons.length === 0) reasons.push(`proof root ${proof.root} does not match expected root ${targetRoot}`);
  return { ok: reasons.length === 0, reasons };
}

/** Re-serialize a mesh for a manifest file (stable field order, plain JSON). */
export function meshToJson(mesh: Mesh): string {
  return JSON.stringify(mesh, null, 2) + "\n";
}
