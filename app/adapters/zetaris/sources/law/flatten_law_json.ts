#!/usr/bin/env node
/**
 * flatten_law_json.ts
 * ==============================================================================
 * Flattens the 4 law JSON documents into canonical tabular CSV / JSONL format:
 *   1. law_documents (4 rows, metadata per document)
 *   2. law_pages (130 rows total: 5 + 60 + 50 + 15 pages)
 *
 * Generated outputs in app/zetaris/sources/law/data/:
 *   - law_documents.csv
 *   - law_pages.csv
 *
 * Usage:
 *   node --experimental-strip-types app/zetaris/sources/law/flatten_law_json.ts
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JSON_DIR = path.join(__dirname, "json");
const DATA_DIR = path.join(__dirname, "data");

interface LawPage {
  page: number;
  is_provenance_page: boolean;
  text: string;
}

interface LawDocJson {
  schema_version: string;
  document_id: string;
  file: string;
  instrument: string;
  instrument_code: string;
  law_as_at: string;
  source_url: string;
  source_host: string;
  source_pdf_sha256: string;
  source_pdf_sha256_file: string;
  pages_original: number;
  pages_final: number;
  ingest_role: string;
  provenance_page_appended: boolean;
  extracted_at: string;
  extraction_method: string;
  pages: LawPage[];
}

function escapeCsv(val: any): string {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const files = [
    "PUA460-2003_EnvironmentalQualityOpenBurningOrder2003.json",
    "Act127_EnvironmentalQualityAct1974_asat-2006.json",
    "Act341_FireServicesAct1988_asat-2009.json",
    "A1712_EnvironmentalQualityAmendmentAct2024.json",
  ];

  const docHeaders = [
    "document_id",
    "file_name",
    "instrument",
    "instrument_code",
    "law_as_at",
    "ingest_role",
    "pages_original",
    "pages_final",
    "source_url",
    "source_host",
    "source_pdf_sha256",
    "extracted_at",
  ];

  const pageHeaders = [
    "document_id",
    "page_number",
    "is_provenance_page",
    "page_text",
  ];

  const docRows: string[][] = [];
  const pageRows: string[][] = [];

  for (const filename of files) {
    const filePath = path.join(JSON_DIR, filename);
    const content = await fs.readFile(filePath, "utf-8");
    const doc: LawDocJson = JSON.parse(content);

    docRows.push([
      doc.document_id,
      doc.file,
      doc.instrument,
      doc.instrument_code,
      doc.law_as_at,
      doc.ingest_role,
      String(doc.pages_original),
      String(doc.pages_final),
      doc.source_url,
      doc.source_host,
      doc.source_pdf_sha256,
      doc.extracted_at,
    ]);

    for (const p of doc.pages) {
      pageRows.push([
        doc.document_id,
        String(p.page),
        String(p.is_provenance_page),
        p.text.trim(),
      ]);
    }
  }

  // Write law_documents.csv
  const docCsvContent = [
    docHeaders.join(","),
    ...docRows.map((r) => r.map(escapeCsv).join(",")),
  ].join("\n") + "\n";
  const docCsvPath = path.join(DATA_DIR, "law_documents.csv");
  await fs.writeFile(docCsvPath, docCsvContent, "utf-8");
  console.log(`✓ Generated ${docCsvPath} (${docRows.length} documents)`);

  // Write law_pages.csv
  const pageCsvContent = [
    pageHeaders.join(","),
    ...pageRows.map((r) => r.map(escapeCsv).join(",")),
  ].join("\n") + "\n";
  const pageCsvPath = path.join(DATA_DIR, "law_pages.csv");
  await fs.writeFile(pageCsvPath, pageCsvContent, "utf-8");
  console.log(`✓ Generated ${pageCsvPath} (${pageRows.length} pages total)`);
}

main().catch((err) => {
  console.error("Error flattening law JSON:", err);
  process.exit(1);
});
