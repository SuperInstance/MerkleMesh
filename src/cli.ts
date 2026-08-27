#!/usr/bin/env node
// cli.ts — the merklemesh command line.
//
//   merklemesh verify <journal.jsonl>            verify one journal's chain
//   merklemesh aggregate <dir|file...> [--root-only] [--mesh path] [--proofs]
//                                                build the fleet mesh
//   merklemesh prove <journal.jsonl> --mesh <mesh.json> [--root <hex>]
//                                                prove inclusion in a fleet

import { parseArgs } from "node:util";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadJournal, verifyJournal, chainHash } from "./ledger.js";
import { buildMesh, proveMesh, verifyInclusion, type Mesh } from "./mesh.js";

const USAGE = `usage:
  merklemesh verify <journal.jsonl>
      Verify one journal's hash chain end to end.
  merklemesh aggregate <dir|journal.jsonl...> [--root-only] [--mesh <path>] [--proofs]
      Verify every *.jsonl journal and build the fleet mesh (one Merkle
      root over all chain hashes). Writes ./mesh.json by default (and
      <journal>.proof.json files with --proofs); --root-only prints just
      the root. Skipped (failing) journals are listed on stderr.
  merklemesh prove <journal.jsonl> --mesh <mesh.json> [--root <hex>]
      Verify the journal's chain AND its inclusion in the fleet root.`;

function fail(msg: string, code = 2): never {
  console.error(`merklemesh: ${msg}`);
  process.exit(code);
}

async function collectJournals(inputs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const input of inputs) {
    const st = await stat(input).catch(() => null);
    if (!st) fail(`no such path: ${input}`);
    if (st.isDirectory()) {
      const names = (await readdir(input)).filter((n) => n.endsWith(".jsonl")).sort();
      for (const n of names) out.push(join(input, n));
    } else {
      out.push(input);
    }
  }
  if (out.length === 0) fail("no *.jsonl journals found");
  return out;
}

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "root-only": { type: "boolean" },
    mesh: { type: "string" },
    proofs: { type: "boolean" },
    root: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const args = flags;
const [cmd, ...rest] = positionals;
if (args.help || !cmd) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 2);
}

switch (cmd) {
  case "verify": {
    const [file] = rest;
    if (!file) fail("verify needs a journal path");
    const journal = await loadJournal(file).catch((e: unknown) =>
      fail(String(e instanceof Error ? e.message : e)),
    );
    const audit = verifyJournal(journal);
    if (!audit.intact) fail(`chain broken at seq ${audit.firstBreak}: ${audit.reason}`, 1);
    if (!audit.headerOk)
      fail(
        `header chain_hash is stale: journal verifies to ${chainHash(journal)}, header says ${journal.header.chainHash}`,
        1,
      );
    console.log(
      `ok  ${file}  cell=${journal.header.cellId}  entries=${journal.entries.length}  chain_hash=${chainHash(journal)}`,
    );
    break;
  }

  case "aggregate": {
    const files = await collectJournals(rest);
    const journals = [];
    for (const f of files) {
      journals.push(await loadJournal(f).catch((e: unknown) => fail(String(e instanceof Error ? e.message : e))));
    }
    const mesh = buildMesh(journals, { builtAt: Date.now() });
    for (const s of mesh.skipped) console.error(`skipped ${s.path}: ${s.reason}`);
    console.log(mesh.root);
    if (!args["root-only"]) {
      const meshPath = args.mesh ?? "mesh.json";
      await writeFile(meshPath, JSON.stringify(mesh, null, 2) + "\n");
      if (args.proofs) {
        for (const leaf of mesh.leaves) {
          const proof = proveMesh(mesh, leaf.cell_id);
          const src = files.find((f) => basename(f, ".jsonl") === leaf.cell_id) ?? `${leaf.cell_id}.jsonl`;
          const p = src.replace(/\.jsonl$/, ".proof.json");
          await writeFile(p, JSON.stringify(proof, null, 2) + "\n");
          console.error(`proof  ${leaf.cell_id} -> ${p}`);
        }
      }
      console.error(`mesh   ${mesh.leaves.length} ledgers -> ${meshPath}`);
    }
    break;
  }

  case "prove": {
    const [file] = rest;
    if (!file) fail("prove needs a journal path");
    if (!args.mesh) fail("prove needs --mesh <mesh.json>");
    const journal = await loadJournal(file).catch((e: unknown) =>
      fail(String(e instanceof Error ? e.message : e)),
    );
    const meshRaw = JSON.parse(await readFile(args.mesh, "utf8")) as Mesh;
    if (meshRaw.kind !== "merklemesh/mesh/1") fail(`${args.mesh}: not a merklemesh manifest`);
    let proof;
    try {
      proof = proveMesh(meshRaw, journal.header.cellId);
    } catch (e) {
      fail(String(e instanceof Error ? e.message : e), 1);
    }
    const result = verifyInclusion(journal, proof, args.root);
    if (!result.ok) fail(`inclusion NOT proven:\n  ${result.reasons.join("\n  ")}`, 1);
    console.log(
      `ok  ${file}  cell=${journal.header.cellId}  chain=${proof.chain_hash.slice(0, 16)}…  root=${args.root ?? proof.root}`,
    );
    break;
  }

  default:
    fail(`unknown command ${JSON.stringify(cmd)}\n\n${USAGE}`);
}

process.exit(0);
