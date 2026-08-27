// cli.test.ts — the merklemesh binary end to end: verify, aggregate,
// prove — against the Rust-generated golden fixtures, in a temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, cp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const FIX = join(import.meta.dirname, "fixtures");

const GOLDEN_ROOT_3 = buildRoot3();

// Compute the expected 3-boat root once via the library, so the CLI
// test checks CLI behavior (not yet another hardcoded hash — those
// live in ledger.test.ts).
async function buildRoot3(): Promise<string> {
  const m = await import("../dist/index.js");
  const files = ["boat-1.jsonl", "boat-2.jsonl", "boat-3.jsonl"];
  const journals = await Promise.all(
    files.map((f) => m.loadJournal(join(FIX, f))),
  );
  return m.buildMesh(journals).root;
}

async function tmpFleet(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mm-fleet-"));
  // a fleet of the three boats (empty-ledger fixtures are exercised in mesh.test.ts)
  for (const f of ["boat-1.jsonl", "boat-2.jsonl", "boat-3.jsonl"]) {
    await cp(join(FIX, f), join(dir, f));
  }
  return dir;
}

test("cli: verify reports ok on a golden journal", async () => {
  const { stdout } = await run(process.execPath, [CLI, "verify", join(FIX, "boat-1.jsonl")]);
  assert.match(stdout, /^ok/);
  assert.match(stdout, /cell=bilge\.level/);
  assert.match(stdout, /chain_hash=7b8966bb/);
});

test("cli: verify exits 1 on a tampered journal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mm-bad-"));
  const text = (await readFile(join(FIX, "boat-1.jsonl"), "utf8")).replace('"value":77.5', '"value":99.5');
  const bad = join(dir, "bad.jsonl");
  await writeFile(bad, text);
  const res = await run(process.execPath, [CLI, "verify", bad]).catch((e) => e);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /seal mismatch at seq 2/);
});

test("cli: aggregate builds mesh.json and prints the root", async () => {
  const dir = await tmpFleet();
  const { stdout, stderr } = await run(process.execPath, [CLI, "aggregate", dir], { cwd: dir });
  assert.equal(stdout.trim(), await GOLDEN_ROOT_3);
  assert.match(stderr, /3 ledgers/);
  const mesh = JSON.parse(await readFile(join(dir, "mesh.json"), "utf8"));
  assert.equal(mesh.kind, "merklemesh/mesh/1");
  assert.equal(mesh.root, await GOLDEN_ROOT_3);
  assert.equal(mesh.leaves.length, 3);
  assert.deepEqual(mesh.skipped, []);
});

test("cli: aggregate --root-only prints the root, writes nothing", async () => {
  const dir = await tmpFleet();
  const { stdout } = await run(
    process.execPath, [CLI, "aggregate", dir, "--root-only"], { cwd: dir },
  );
  assert.equal(stdout.trim(), await GOLDEN_ROOT_3);
  const files = await readdir(dir);
  assert.ok(!files.includes("mesh.json"));
});

test("cli: aggregate --proofs writes per-journal proof files", async () => {
  const dir = await tmpFleet();
  await run(process.execPath, [CLI, "aggregate", dir, "--proofs"], { cwd: dir });
  const files = (await readdir(dir)).sort();
  // proofs are named by cell_id (filenames are arbitrary; cell ids are the identity)
  assert.ok(files.includes("bilge.level.proof.json"), files.join(","));
  assert.ok(files.includes("radio.status.proof.json"));
  assert.ok(files.includes("sonar.range.proof.json"));
});

test("cli: prove succeeds against the mesh from the same fleet", async () => {
  const dir = await tmpFleet();
  await run(process.execPath, [CLI, "aggregate", dir], { cwd: dir });
  const { stdout } = await run(
    process.execPath, [CLI, "prove", join(dir, "boat-2.jsonl"), "--mesh", join(dir, "mesh.json")],
  );
  assert.match(stdout, /^ok/);
  assert.match(stdout, /cell=radio\.status/);
});

test("cli: prove fails (exit 1) when the journal is not in the fleet", async () => {
  const dir = await tmpFleet();
  await run(process.execPath, [CLI, "aggregate", dir, "--mesh", join(dir, "mesh.json")], { cwd: dir });
  // mesh over 2 of 3 boats, then prove the third
  const two = await mkdtemp(join(tmpdir(), "mm-two-"));
  await cp(join(FIX, "boat-1.jsonl"), join(two, "boat-1.jsonl"));
  await cp(join(FIX, "boat-2.jsonl"), join(two, "boat-2.jsonl"));
  await run(process.execPath, [CLI, "aggregate", two], { cwd: two });
  const res = await run(
    process.execPath,
    [CLI, "prove", join(FIX, "boat-3.jsonl"), "--mesh", join(two, "mesh.json")],
  ).catch((e) => e);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /not in the mesh/);
});

test("cli: prove fails against a wrong root even with a good mesh", async () => {
  const dir = await tmpFleet();
  await run(process.execPath, [CLI, "aggregate", dir, "--mesh", join(dir, "mesh.json")], { cwd: dir });
  const res = await run(
    process.execPath,
    [
      CLI, "prove", join(dir, "boat-1.jsonl"),
      "--mesh", join(dir, "mesh.json"),
      "--root", "f".repeat(64),
    ],
  ).catch((e) => e);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /does not match expected root/);
});

test("cli: aggregate with a tampered journal reports it on stderr", async () => {
  const dir = await tmpFleet();
  const bad = join(dir, "boat-2.jsonl");
  await writeFile(bad, (await readFile(bad, "utf8")).replace('"online"', '"offline"'));
  const { stderr } = await run(process.execPath, [CLI, "aggregate", dir], { cwd: dir });
  assert.match(stderr, /skipped .*boat-2/);
  assert.match(stderr, /seal mismatch/);
});

test("cli: unknown command and missing args fail with usage", async () => {
  const res = await run(process.execPath, [CLI, "frobnicate"]).catch((e) => e);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unknown command/);
  const res2 = await run(process.execPath, [CLI]).catch((e) => e);
  assert.equal(res2.code, 2);
});
