# Legacy SmokeLedger USL definitions

This folder contains legacy PostgreSQL-backed USL definitions. Its
`bootstrap_smokeledger.ts` entry point was removed and this USL is not invoked
by `bootstrap_usl.ts`. No supported bootstrap command currently registers or
activates these definitions. The live environmental sources use Zetaris REST
federation and do not depend on this legacy model.
