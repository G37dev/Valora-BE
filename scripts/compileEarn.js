const solc = require("solc");
const fs = require("fs");
const path = require("path");

const findImport = (p) => {
  const resolved = path.resolve(__dirname, "../node_modules", p);
  if (!fs.existsSync(resolved)) return { error: `not found: ${p}` };
  return { contents: fs.readFileSync(resolved, "utf8") };
};

for (const name of ["EarnAssetPool", "EarnRouter"]) {
  const SRC = path.join(__dirname, `../contracts/${name}.sol`);
  const OUT_DIR = path.join(__dirname, `../artifacts/${name}.sol`);
  const OUT = path.join(OUT_DIR, `${name}.json`);

  const input = {
    language: "Solidity",
    sources: { [`contracts/${name}.sol`]: { content: fs.readFileSync(SRC, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };

  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
  let failed = false;
  for (const e of out.errors || []) {
    const line = e.formattedMessage || e.message;
    if (e.severity === "error") { failed = true; console.error(line); }
    else console.warn(`warn: ${line}`);
  }
  if (failed) process.exit(1);

  const compiled = out.contracts[`contracts/${name}.sol`][name];
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(
    { abi: compiled.abi, evm: { bytecode: compiled.evm.bytecode, deployedBytecode: compiled.evm.deployedBytecode } },
    null, 2,
  ));
  console.log(`OK -> ${path.relative(process.cwd(), OUT)} (${compiled.evm.bytecode.object.length / 2} bytes)`);
}
