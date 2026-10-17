/*
 * Generate URL deploy thirdweb dashboard untuk LoanCollateralEscrow —
 * replikasi persis flow `npx thirdweb deploy` (legacy CLI `bo()`):
 *
 *   1. compile solc (optimizer 800 runs, outputSelection "*")          — sama dgn CLI solc path
 *   2. upload tiap source .sol ke IPFS  (uploadWithoutDirectory)       — utk resolvable sources di metadata
 *   3. upload metadata JSON             (uploadWithoutDirectory)       -> metadataUri
 *   4. upload bytecode via batch (wrapped dir)                          -> bytecodeUri (ipfs://<dir>/0)
 *   5. upload deploy doc {name, metadataUri, bytecodeUri, analytics,
 *      compilers.solc[]}                (uploadWithoutDirectory)
 *   6. print https://thirdweb.com/contracts/deploy/<CID>
 *
 * User tinggal buka URL -> connect wallet -> isi constructor -> pilih
 * chain -> deploy. Contract otomatis muncul di dashboard thirdweb.
 *
 *   node scripts/publishLoanEscrowForDeploy.js
 */
require("dotenv").config();
const solc = require("solc");
const fs = require("fs");
const path = require("path");

const CONTRACT_NAME = "LoanCollateralEscrow";
const SRC_FILE = path.join(__dirname, "../contracts", `${CONTRACT_NAME}.sol`);
const CLI_VERSION = "0.14.12"; // @thirdweb-dev/cli terakhir yang dipakai lokal

const resolveSource = (key) => {
  const candidates = [
    path.resolve(__dirname, "../contracts", key),
    path.resolve(__dirname, "..", key),
    path.resolve(__dirname, "../node_modules", key),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
};

async function main() {
  const { client } = require("../utils/thirdweb");
  const { upload } = await import("thirdweb/storage");

  // ---- 1. compile ----
  const input = {
    language: "Solidity",
    sources: { [`${CONTRACT_NAME}.sol`]: { content: fs.readFileSync(SRC_FILE, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 800 },
      outputSelection: { "*": { "*": ["*"] } },
    },
  };
  const findImport = (p) => {
    const resolved = path.resolve(__dirname, "../node_modules", p);
    return fs.existsSync(resolved)
      ? { contents: fs.readFileSync(resolved, "utf8") }
      : { error: `not found: ${p}` };
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) {
    errors.forEach((e) => console.error(e.formattedMessage || e.message));
    process.exit(1);
  }
  const compiled = out.contracts[`${CONTRACT_NAME}.sol`][CONTRACT_NAME];
  const metaObj = JSON.parse(compiled.metadata);
  const bytecode = compiled.evm.bytecode.object;
  const compilerVersion = metaObj.compiler.version;
  const evmVersion = metaObj.settings?.evmVersion || "";
  const sourceKeys = Object.keys(metaObj.sources || {});
  console.log(`compiled: ${CONTRACT_NAME} solc ${compilerVersion} evm=${evmVersion || "default"}, sources=${sourceKeys.length}`);

  // ---- 2. upload sources (agar ipfs urls di metadata resolvable) ----
  let usesTwExtensions = false;
  for (const key of sourceKeys) {
    const p = resolveSource(key);
    if (!p) {
      console.warn(`warn: source ${key} tidak ditemukan di disk, skip`);
      continue;
    }
    const content = fs.readFileSync(p, "utf8");
    if (content.includes("@thirdweb-dev/contracts")) usesTwExtensions = true;
    await upload({ client, files: [content], uploadWithoutDirectory: true });
  }
  console.log("sources uploaded");

  // ---- 3+4. metadata + bytecode ----
  const metadataUri = await upload({ client, files: [metaObj], uploadWithoutDirectory: true });
  const bytecodeUri = await upload({ client, files: [bytecode] });
  console.log(`metadataUri: ${metadataUri}`);
  console.log(`bytecodeUri: ${bytecodeUri}`);

  // ---- 5. deploy doc (shape persis output CLI bo()) ----
  const doc = {
    name: CONTRACT_NAME,
    metadataUri,
    bytecodeUri,
    analytics: {
      command: "deploy",
      contract_name: CONTRACT_NAME,
      cli_version: CLI_VERSION,
      project_type: "solc",
      from_ci: false,
      uses_contract_extensions: usesTwExtensions,
    },
    compilers: {
      solc: [{ compilerVersion, evmVersion, metadataUri, bytecodeUri }],
    },
  };
  const docUri = await upload({ client, files: [doc], uploadWithoutDirectory: true });
  const cid = docUri.replace("ipfs://", "");
  const url = `https://thirdweb.com/contracts/deploy/${encodeURIComponent(cid)}`;

  console.log(`\n=== DEPLOY URL ===\n${url}\n`);
  console.log("Buka link di browser -> connect wallet -> isi constructor args -> pilih chain -> deploy.");
  console.log("Constructor args (per asset, deploy 2x):");
  console.log("  _assetToken, _governanceSafe, _operator, _settlementSigner, _treasurySafe");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
