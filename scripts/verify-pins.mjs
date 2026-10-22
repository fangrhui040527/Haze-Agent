import { verifySources, verifyWorkflowPins } from './engine-sources.mjs';

await verifySources();
await verifyWorkflowPins();
console.log(
  'Verified engine source checksums, licenses, lockfiles and workflow dependency pins.',
);
