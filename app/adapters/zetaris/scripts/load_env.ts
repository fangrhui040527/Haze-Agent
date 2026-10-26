// Loads the Haze root .env as a side effect of importing this module.
// Process variables win; the main checkout and legacy adapter .env.local
// supply missing settings. Needs --allow-read and the relevant --allow-env.
//
// Needs --allow-read. Setting a variable outside the script's --allow-env list
// is skipped, not an error.

import { envFileCandidates } from "./env-files.ts";
export { envFileCandidates } from "./env-files.ts";

function load(): string | null {
  let loaded: string | null = null;
  for (const path of envFileCandidates()) {
    let text: string;
    try {
      text = Deno.readTextFileSync(path);
    } catch {
      continue;
    }
    loaded ??= path;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const i = line.indexOf("=");
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if (
        value.length >= 2 && value[0] === value[value.length - 1] &&
        (value[0] === '"' || value[0] === "'")
      ) value = value.slice(1, -1);
      try {
        if (Deno.env.get(key) === undefined) Deno.env.set(key, value);
      } catch {
        // not permitted by --allow-env; the script does not need this variable
      }
    }
  }
  return loaded;
}

export const envFile = load();
