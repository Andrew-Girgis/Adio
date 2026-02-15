#!/usr/bin/env python3
"""Extract per-page text from a PDF for Adio ingestion (stdout JSON).

This helper reuses the PDF parsing + normalization logic from ingest_appliance_pdfs.py so
the Node server can fall back to python extraction when pdfjs-dist isn't available.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from ingest_appliance_pdfs import extract_page_records, extract_pdf_title


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract normalized page text from a PDF (JSON stdout).")
    parser.add_argument("--pdf", required=True, help="Path to a PDF file.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pdf_path = Path(args.pdf).resolve()
    pages = extract_page_records(pdf_path)
    metadata_title = extract_pdf_title(pdf_path)

    payload = {
        "metadataTitle": metadata_title,
        "pages": [
            {
                "pageNumber": page.page_number,
                "text": page.text,
                "paragraphs": page.paragraphs,
                "wordCount": page.word_count,
            }
            for page in pages
        ],
    }

    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

