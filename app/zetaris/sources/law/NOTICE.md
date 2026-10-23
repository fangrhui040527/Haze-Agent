NOTICE
======

Source basis for the law documents held in the pdf/ folder.

This is a record of where the documents came from and why they may be used as reference texts. It is not a licence. The licence for the project metadata is in LICENSE.

What these documents are not, and the limits of this collection, is in DISCLAIMER.md. What each file is, how json/ is built, and how to cite is in README.md.


PURPOSE AND USE
---------------

Prepared for a hackathon prototype. The texts are held for internal reference while building and demonstrating an AI agent that reads recorded law text.

Use is limited to that purpose:

  - non-commercial;
  - internal;
  - no redistribution of the source PDFs.

The pdf/ folder holds the source copies and must not be published in a public repository. If this project is published, publish the derived metadata and json/ only, and leave pdf/ out.

No personal data is stored. No legal advice is given. No exemption or permission is claimed beyond what is stated here and in LICENSE.


SOURCES
-------

  AGC portal        https://lom.agc.gov.my
                    Attorney General's Chambers, Malaysia. Publishes the Laws of
                    Malaysia.

  FAOLEX            https://faolex.fao.org
                    UN Food and Agriculture Organization. Used only where no AGC
                    copy was available.

Basis of use: official, free, and publicly accessible government texts, kept as public reference material. No personal data is stored. No legal advice is given.


DOCUMENTS
---------

  1. Environmental Quality (Declared Activities) (Open Burning) Order 2003
     P.U.(A) 460/2003 - in force 1 January 2004
     Source: FAOLEX    https://faolex.fao.org/docs/pdf/mal70151.pdf

  2. Environmental Quality Act 1974
     Act 127 - as at 1 January 2006
     Source: AGC       https://lom.agc.gov.my/ilims/upload/portal/akta/LOM/EN/Act%20127.pdf

  3. Environmental Quality (Amendment) Act 2024
     Act A1712 - in force 7 July 2024
     Source: AGC       https://lom.agc.gov.my/ilims/upload/portal/akta/outputaktap/2147523_BI/Act%20A1712.pdf

  4. Fire Services Act 1988
     Act 341 - as at 1 October 2009
     Source: AGC       https://lom.agc.gov.my/ilims/upload/portal/akta/LOM/EN/Act%20341.pdf


PROVENANCE
----------

Each PDF has a provenance page added as its last page. That page records the file name, the source link, the host, the instrument, the revision date, who obtained it, the date, the page count, and the SHA-256 hash of the file before the page was added.

The full register, with SHA-256 hashes, is pdf_manifest.json in this folder.

Byte identity with the remote file is not established for any document. Every source link was confirmed to serve the same instrument as the local copy by comparing title, dates, and body text.


EXCLUDED DOCUMENTS
------------------

Ten further documents were obtained but are not part of this set. They are listed, with the reason for exclusion, in pdf_manifest.json under "excluded_from_ingest". The originals remain in law_agent/sources/pdf/.

Governance Acts (Copyright, Legal Profession, Interpretation, Revision of Laws) must never be loaded as retrievable content. They are not rules to apply; they are the rules of how these texts are sourced and cited. 