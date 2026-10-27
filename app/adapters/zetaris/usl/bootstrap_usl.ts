#!/usr/bin/env node
/**
 * Bootstrap Malaysia Environmental, Law, and SmokeLedger USLs without running
 * the optional post-bootstrap entity verification queries.
 */

import { main } from "./bootstrap_usl_and_verify.ts";

main(false).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
