// index.ts — MerkleMesh public API.
//
// Merkle aggregation and inclusion proofs over quilt cell-ledger
// journals: many ledgers (a fleet of boats), one Merkle root, per-boat
// inclusion proofs. The ledger chain rules are ported bit-for-bit from
// quilt-core's `packages/core/src/ledger.rs`.

export { sha256Hex, sha256HexStr } from "./sha256.js";
export {
  parsePreserving,
  canonicalJson,
  canonicalNumber,
  RawNumber,
  type Json,
} from "./canonical.js";
export {
  parseJournal,
  loadJournal,
  verifyChain,
  verifyJournal,
  chainHash,
  genesisCommit,
  JournalError,
  JOURNAL_KIND,
  GENESIS_KIND,
  type Journal,
  type LedgerHeader,
  type LedgerEntry,
  type ChainAudit,
} from "./ledger.js";
export {
  buildMesh,
  proveMesh,
  verifyProof,
  verifyInclusion,
  meshToJson,
  MESH_KIND,
  PROOF_KIND,
  type Mesh,
  type MeshLeaf,
  type MeshProof,
  type MeshProofStep,
} from "./mesh.js";
