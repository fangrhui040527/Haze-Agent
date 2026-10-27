#!/usr/bin/env node
// node run.mjs --input FILE [--out FILE]
// Executes the same run contract as POST /run (or a scenario with steps), prints the JSON result.
import { tsImport } from "tsx/esm/api";

const cli = await tsImport("./src/runcli.ts", import.meta.url);
process.exitCode = await cli.main(process.argv.slice(2));
