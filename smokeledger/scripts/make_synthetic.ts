// Writes the FICTIONAL sample episode to data/raw/synthetic/ (see src/sample.ts).
import path from "node:path";
import { generateSample } from "../src/sample.ts";

const out = path.join("data", "raw", "synthetic");
console.log(`Synthetic (fictional) episode written to ${out}/`);
console.log(generateSample(out).join("\n"));
