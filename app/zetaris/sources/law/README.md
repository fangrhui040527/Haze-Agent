law/
====

Reference copies of Malaysian law texts used by the Haze Agent.

Prepared for a hackathon prototype, for internal reference and demonstration. Non-commercial. Not for reliance. See DISCLAIMER.md and NOTICE.md.

**Read [DISCLAIMER.md](DISCLAIMER.md) first.** It records what these documents are not: not the official text, not complete, and not legal advice.


WHAT IS IN THIS FOLDER
----------------------

| Path                  | What it is                                                        | Edit it?        |
| --------------------- | ----------------------------------------------------------------- | --------------- |
| `pdf/`                | The PDFs as downloaded, each with a provenance page as its last page. This is the source of truth. | No              |
| `json/`               | Text copied out of the PDFs. One file per document. One entry per page. | No -- regenerate |
| `pdf_manifest.json`   | The register. Every document, its source link, its revision date, its hashes, and the documents left out. | Yes, by hand    |
| `DISCLAIMER.md`       | The limits of this collection.                                    | Yes             |
| `NOTICE.md`           | Where the documents came from, and why they may be used.          | Yes             |
| `LICENSE`             | Licence for the project metadata only. Not for the law texts.     | No              |

Two folders hold the same four documents. `pdf/` is the original. `json/` is a copy of the text inside it, made by a script so it can be checked.


HOW json/ IS BUILT
------------------

`law_agent/transcribe_law.py` reads `pdf_manifest.json`, checks each PDF's SHA-256 against the register, and copies the text out of the PDF.

    python law_agent/transcribe_law.py --format json            # write law/json/
    python law_agent/transcribe_law.py --format json --verify   # re-derive and compare
    python law_agent/transcribe_law.py --format json --report   # list repeated header/footer lines

What it guarantees:

  - If a PDF's hash does not match the register, nothing is written.
  - Text is copied exactly. Unusual spacing is kept, not tidied.
  - Nothing is summarised, classified, or corrected.

The same PDF and the same PyMuPDF version produce the same output, byte for byte, so the files can be re-derived and compared. This works against the PDF's text layer, not against the printed page. The extractor name and version are recorded in every file, because the output is only reproducible relative to it.


HOW TO CITE
-----------

Always include the revision date. A citation without it cannot be checked.

    <instrument_code>, <law_as_at> (source: <source_host>, sha256 <source_pdf_sha256>)

For example:

    P.U.(A) 460/2003, in force 1 January 2004
    (source: faolex.fao.org, sha256 2fff0e979530...)

Each `json/` file carries these fields on every record, so a citation can be built without opening the manifest.


WHAT IS NOT IN HERE
-------------------

Four documents is a small subset, not the law on open burning.

| Not held                                 | Why it matters                                          |
| ---------------------------------------- | ------------------------------------------------------- |
| A1793, the 2026 amendment to Act 127     | The newest amendment. Without it the parent Act is out of date. |
| Act 514, Occupational Safety and Health 1994 | Worker heat and safety duties are not covered.       |
| DOSH and MOH guidance                    | Practical limits are not covered.                       |
| A consolidated Act 127                   | Only the 2006 reprint is held, which is stale.          |

Act 341 (Fire Services 1988) is marked `definitional_dependency`. It is held only so that terms used by the Open Burning Order can be resolved. It is not there to be applied on its own.

The full list, with reasons, is in `pdf_manifest.json` under `excluded_from_ingest`.


WHAT THIS FOLDER DELIBERATELY DOES NOT DO
-----------------------------------------

  - No legal advice, opinions, or conclusions.
  - No personal data.
  - No section labels or legal summaries added to the text. The files hold what
    the PDF says, and nothing else.


BEFORE YOU PUBLISH
------------------

Leave `pdf/` out. Do not commit the source PDFs to a public repository.

Safe to publish: `pdf_manifest.json`, `README.md`, `DISCLAIMER.md`, `NOTICE.md`, `LICENSE`, the `json/` text, and the provenance pages. 