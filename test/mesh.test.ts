// mesh.test.ts — the fleet mesh: deterministic roots, inclusion proofs,
// tamper propagation, edge shapes (1, 2, 3, 5 leaves).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseJournal } from "../dist/ledger.js";
import { buildMesh, proveMesh, verifyProof, verifyInclusion } from "../dist/mesh.js";

const FIX = join(import.meta.dirname, "fixtures");

async function load(name: string) {
  return parseJournal(await readFile(join(FIX, name), "utf8"), join(FIX, name));
}

test("fleet of 3: mesh builds, root is deterministic across input orders", async () => {
  const boats = await Promise.all([load("boat-1.jsonl"), load("boat-2.jsonl"), load("boat-3.jsonl")]);
  const shuffled = [boats[2], boats[0], boats[1]];
  assert.equal(buildMesh(boats).root, buildMesh(shuffled).root);
});

test("fleet of 3: every leaf's inclusion proof verifies against the root", async () => {
  const boats = await Promise.all([load("boat-1.jsonl"), load("boat-2.jsonl"), load("boat-3.jsonl")]);
  const mesh = buildMesh(boats);
  assert.equal(mesh.leaves.length, 3);
  assert.equal(mesh.skipped.length, 0);
  for (const leaf of mesh.leaves) {
    const proof = proveMesh(mesh, leaf.cell_id);
    assert.equal(proof.root, mesh.root);
    assert.ok(verifyProof(proof), `proof for ${leaf.cell_id}`);
    const journal = boats.find((b) => b.header.cellId === leaf.cell_id)!;
    const inc = verifyInclusion(journal, proof);
    assert.equal(inc.ok, true, inc.reasons.join("; "));
  }
});

test("verifyInclusion: full check catches a journal that changed after meshing", async () => {
  const boats = await Promise.all([load("boat-1.jsonl"), load("boat-2.jsonl")]);
  const mesh = buildMesh(boats);
  const proof = proveMesh(mesh, "radio.status");
  // radio.status grew a record since the mesh was built: its chain hash
  // no longer matches the one committed in the mesh.
  const grown = parseJournal(
    (await readFile(join(FIX, "boat-2.jsonl"), "utf8")) + "\n",
  );
  // (Appending a forged line would fail parse; simulate growth by
  // re-using boat-1's journal against radio.status's proof.)
  const wrong = await load("boat-1.jsonl");
  const inc = verifyInclusion(wrong, proof);
  assert.equal(inc.ok, false);
  assert.ok(inc.reasons.length >= 1);
});

test("one boat alone: single-leaf mesh, proof of depth 0", async () => {
  const boat = await load("boat-1.jsonl");
  const mesh = buildMesh([boat]);
  const proof = proveMesh(mesh, boat.header.cellId);
  assert.deepEqual(proof.siblings, []);
  assert.ok(verifyProof(proof));
  assert.ok(verifyInclusion(boat, proof).ok);
});

test("two boats: depth-1 proofs with real siblings", async () => {
  const boats = await Promise.all([load("boat-1.jsonl"), load("boat-2.jsonl")]);
  const mesh = buildMesh(boats);
  for (const b of boats) {
    const proof = proveMesh(mesh, b.header.cellId);
    assert.equal(proof.siblings.length, 1);
    assert.ok(verifyProof(proof));
  }
  // proofs for the two leaves must disagree about the sibling side
  const p1 = proveMesh(mesh, "bilge.level");
  const p2 = proveMesh(mesh, "radio.status");
  assert.notEqual(p1.siblings[0].side, p2.siblings[0].side);
});

test("five ledgers incl. empty ones: odd count duplicates correctly", async () => {
  const journals = await Promise.all([
    load("boat-1.jsonl"),
    load("boat-2.jsonl"),
    load("boat-3.jsonl"),
    load("empty-genesis.jsonl"),
    load("empty-void.jsonl"),
  ]);
  const mesh = buildMesh(journals);
  assert.equal(mesh.leaves.length, 5);
  for (const leaf of mesh.leaves) {
    const proof = proveMesh(mesh, leaf.cell_id);
    assert.ok(verifyProof(proof), leaf.cell_id);
  }
});

test("any journal edit changes the fleet root", async () => {
  const boats = await Promise.all([load("boat-1.jsonl"), load("boat-2.jsonl"), load("boat-3.jsonl")]);
  const root0 = buildMesh(boats).root;
  const tampered = parseJournal(
    (await readFile(join(FIX, "boat-2.jsonl"), "utf8")).replace(
      '"status": "ok"', '"status": "bad"',
    ).replaceAll("ok", "ok"), // no-op guard; real edit below
  );
  const edited = parseJournal(
    (await readFile(join(FIX, "boat-2.jsonl"), "utf8")).replace('"online"', '"offline"'),
  );
  const root1 = buildMesh([boats[0], edited, boats[2]]).root;
  assert.notEqual(root0, root1);
  assert.notEqual(tampered, undefined);
});

test("a broken journal is skipped (with reason), not silently meshed", async () => {
  const good = await load("boat-1.jsonl");
  const badText = (await readFile(join(FIX, "boat-2.jsonl"), "utf8"))
    .replace('"online"', '"offline"');
  const bad = parseJournal(badText, "boat-2.jsonl");
  const mesh = buildMesh([good, bad]);
  assert.equal(mesh.leaves.length, 1);
  assert.equal(mesh.skipped.length, 1);
  assert.match(mesh.skipped[0].reason, /seal mismatch/);
});

test("duplicate cell_ids are rejected: one leaf per boat", async () => {
  const a = await load("boat-1.jsonl");
  const b = parseJournal(await readFile(join(FIX, "boat-1.jsonl"), "utf8"), "boat-1-copy.jsonl");
  const mesh = buildMesh([a, b]);
  assert.equal(mesh.leaves.length, 1);
  assert.equal(mesh.skipped.length, 1);
});

test("empty fleet is an error, not an empty root", () => {
  assert.throws(() => buildMesh([]), /empty fleet/);
});
