# Third-party sources

Haze packages Meterless's Agentathon starter, H-MEM reference, and World Model
reference from commit `1742dec56a66e58eef9dda2d2b865823758ca8cd` of
<https://github.com/Meterless/Meterless>. These components are copyright 2026
Meterless and licensed under Apache License 2.0. The complete license and copyright
text is retained beside each component in `third_party/meterless/`, and copied
into the generated vendor output. No upstream NOTICE file is present at this
revision. Preserve any applicable notices when updating the pin.

`engine_sources.json` records the source selections, original Git tree IDs,
per-file SHA-256 checksums, and aggregate checksums. Upstream sources and all
three upstream package-lock.json files are retained byte for byte. The upstream
lockfiles' root package entries still say `MIT`; this is stale upstream metadata.
The accompanying upstream LICENSE files and package.json declarations say
`Apache-2.0`. Haze does not rewrite those lockfiles.

Haze build changes: the starter's floating `degit`/`npm install` setup is replaced
by a checksum-verified local source copy. Haze transpiles TypeScript to JavaScript
with its pinned TypeScript compiler. In the generated starter loader only,
constructed `index.ts` filenames become `index.js`. Original source files remain
unchanged. Generated files carry a modification notice; these adaptations and
the Haze adapters are not upstream releases. The starter's tracked node_modules
directory (including a platform executable) is excluded; dependencies are
resolved using Haze's committed root lockfile.

LangChain Core, LangGraph, and their checkpoint/saver packages retain their
upstream MIT licenses within the installed packages. Other npm packages retain
their respective licenses and notices in node_modules. The runtime image copies
that directory without stripping licenses or notices.
