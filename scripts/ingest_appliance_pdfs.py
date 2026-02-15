#!/usr/bin/env python3
"""Ingest appliance PDF manuals into Supabase for RAG retrieval."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence, TypeVar

from dotenv import load_dotenv
from openai import OpenAI
from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTTextContainer
from pdfminer.pdfdocument import PDFDocument
from pdfminer.pdfparser import PDFParser
from supabase import Client, create_client
from tenacity import retry, stop_after_attempt, wait_exponential

T = TypeVar("T")


DEFAULT_CHUNK_WORDS = 180
DEFAULT_OVERLAP_WORDS = 36
DEFAULT_EMBED_BATCH_SIZE = 64
DEFAULT_UPSERT_BATCH_SIZE = 500
LOW_TEXT_PAGE_WORD_THRESHOLD = 40
PARTIAL_LOW_TEXT_RATIO_THRESHOLD = 0.20
MIN_CHUNK_THRESHOLD = 3

KNOWN_BRANDS = [
    "whirlpool",
    "ge",
    "samsung",
    "lg",
    "bosch",
    "kitchenaid",
    "frigidaire",
    "electrolux",
    "lennox",
    "amana",
    "maytag",
    "kenmore",
    "chamberlain",
]

STOP_MODEL_WORDS = {
    "OWNER",
    "MANUAL",
    "INSTALLATION",
    "INSTRUCTIONS",
    "GUIDE",
    "PRODUCT",
    "WARRANTY",
    "SAFETY",
    "TABLE",
    "CONTENTS",
}


@dataclass
class PageRecord:
    page_number: int
    text: str
    paragraphs: list[str]
    word_count: int


@dataclass
class TokenRecord:
    word: str
    page_number: int
    section: str


@dataclass
class ChunkRecord:
    chunk_index: int
    section: str
    page_start: int
    page_end: int
    token_count: int
    content: str


@dataclass
class DocumentMetadata:
    title: str
    brand: str | None
    model: str | None
    product_domain: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest appliance PDF manuals into Supabase.")
    parser.add_argument(
        "--docs-dir",
        default=str((Path(__file__).resolve().parents[1] / "appliance_docs")),
        help="Directory that contains PDF manuals.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Parse and report only; skip embeddings and DB writes.")
    parser.add_argument("--force", action="store_true", help="Reprocess PDFs even when active rows already use same hash.")
    parser.add_argument("--chunk-words", type=int, default=DEFAULT_CHUNK_WORDS, help="Maximum words per chunk.")
    parser.add_argument("--overlap-words", type=int, default=DEFAULT_OVERLAP_WORDS, help="Word overlap between chunks.")
    parser.add_argument("--embed-batch-size", type=int, default=DEFAULT_EMBED_BATCH_SIZE, help="Embedding batch size.")
    parser.add_argument("--upsert-batch-size", type=int, default=DEFAULT_UPSERT_BATCH_SIZE, help="Chunk upsert batch size.")
    return parser.parse_args()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def split_batches(items: Sequence[T], batch_size: int) -> Iterable[Sequence[T]]:
    for i in range(0, len(items), batch_size):
        yield items[i : i + batch_size]


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:56] if slug else "manual"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_page_text(raw_text: str) -> str:
    text = raw_text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(?<=\w)-\s*\n\s*(?=\w)", "", text)
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.split("\n")]

    paragraphs: list[str] = []
    buf: list[str] = []
    for line in lines:
        if not line:
            if buf:
                paragraphs.append(" ".join(buf).strip())
                buf = []
            continue
        buf.append(line)
    if buf:
        paragraphs.append(" ".join(buf).strip())

    return "\n\n".join(paragraph for paragraph in paragraphs if paragraph)


def split_paragraphs(normalized_text: str) -> list[str]:
    return [part.strip() for part in normalized_text.split("\n\n") if part.strip()]


def extract_page_records(pdf_path: Path) -> list[PageRecord]:
    laparams = LAParams(char_margin=2.0, word_margin=0.1, line_margin=0.4)
    pages: list[PageRecord] = []

    for page_number, layout in enumerate(extract_pages(str(pdf_path), laparams=laparams), start=1):
        text_parts: list[str] = []
        for element in layout:
            if isinstance(element, LTTextContainer):
                piece = element.get_text()
                if piece:
                    text_parts.append(piece)

        normalized = normalize_page_text("\n".join(text_parts))
        paragraphs = split_paragraphs(normalized)
        word_count = len(normalized.split())
        pages.append(
            PageRecord(
                page_number=page_number,
                text=normalized,
                paragraphs=paragraphs,
                word_count=word_count,
            )
        )

    return pages


def decode_pdf_value(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned if cleaned else None
    if isinstance(value, bytes):
        for encoding in ("utf-8", "utf-16", "latin-1"):
            try:
                cleaned = value.decode(encoding, errors="ignore").strip()
                if cleaned:
                    return cleaned
            except Exception:
                continue
    return None


def extract_pdf_title(pdf_path: Path) -> str | None:
    try:
        with pdf_path.open("rb") as fh:
            parser = PDFParser(fh)
            document = PDFDocument(parser)
            for info in document.info or []:
                if not isinstance(info, dict):
                    continue
                title = decode_pdf_value(info.get("Title"))
                if title and not is_noise_title(title):
                    return title
    except Exception:
        return None
    return None


def is_noise_title(title: str) -> bool:
    lowered = title.strip().lower()
    if not lowered:
        return True
    if lowered in {"untitled", "document", "acrobat", "adobe"}:
        return True
    return len(lowered) < 4


def looks_like_heading(paragraph: str) -> bool:
    trimmed = paragraph.strip()
    if not trimmed or len(trimmed) > 100:
        return False
    words = trimmed.split()
    if len(words) > 12:
        return False
    if trimmed.endswith("."):
        return False
    letters = [ch for ch in trimmed if ch.isalpha()]
    if not letters:
        return False
    uppercase_ratio = sum(1 for ch in letters if ch.isupper()) / len(letters)
    return uppercase_ratio > 0.65


def clean_heading(paragraph: str) -> str:
    heading = re.sub(r"\s+", " ", paragraph).strip()
    return heading[:120] if heading else "Overview"


def infer_title(metadata_title: str | None, pages: list[PageRecord], fallback_stem: str) -> str:
    if metadata_title:
        return metadata_title

    if pages:
        for paragraph in pages[0].paragraphs[:12]:
            candidate = re.sub(r"\s+", " ", paragraph).strip()
            if 4 <= len(candidate) <= 120:
                return candidate

    return fallback_stem.replace("_", " ").strip() or fallback_stem


def infer_brand(text: str) -> str | None:
    lowered = text.lower()
    for brand in KNOWN_BRANDS:
        if re.search(rf"\b{re.escape(brand)}\b", lowered):
            return brand
    return None


MODEL_PATTERNS = [
    re.compile(r"\b([A-Z]{2,}[0-9][A-Z0-9_-]{2,})\b"),
    re.compile(r"\b([0-9]{2,}-[0-9A-Z]{2,})\b"),
    re.compile(r"\b([A-Z0-9]{4,}_[A-Z0-9]{2,})\b"),
]


def normalize_model_token(token: str) -> str | None:
    candidate = token.strip().replace("_", "-")
    if len(candidate) < 4:
        return None
    if candidate.upper() in STOP_MODEL_WORDS:
        return None
    return candidate


def infer_model(filename_stem: str, first_page_text: str) -> str | None:
    haystacks = [filename_stem.upper(), first_page_text[:2500].upper()]
    for haystack in haystacks:
        for pattern in MODEL_PATTERNS:
            match = pattern.search(haystack)
            if not match:
                continue
            normalized = normalize_model_token(match.group(1))
            if normalized:
                return normalized
    return None


def build_metadata(pdf_path: Path, pages: list[PageRecord], metadata_title: str | None) -> DocumentMetadata:
    fallback_stem = pdf_path.stem
    first_page_text = pages[0].text if pages else ""
    title = infer_title(metadata_title, pages, fallback_stem)
    joined_context = f"{title}\n{fallback_stem}\n{first_page_text[:3000]}"
    brand = infer_brand(joined_context)
    model = infer_model(fallback_stem, first_page_text)
    return DocumentMetadata(
        title=title,
        brand=brand,
        model=model,
        product_domain="appliance",
    )


def build_token_stream(pages: list[PageRecord]) -> list[TokenRecord]:
    tokens: list[TokenRecord] = []
    current_section = "Overview"

    for page in pages:
        for paragraph in page.paragraphs:
            if looks_like_heading(paragraph):
                current_section = clean_heading(paragraph)
                continue

            words = [word for word in paragraph.split() if word]
            for word in words:
                tokens.append(TokenRecord(word=word, page_number=page.page_number, section=current_section))

    return tokens


def build_chunks(tokens: list[TokenRecord], max_words: int, overlap_words: int) -> list[ChunkRecord]:
    if not tokens:
        return []

    step = max(1, max_words - overlap_words)
    chunks: list[ChunkRecord] = []
    cursor = 0
    chunk_index = 1

    while cursor < len(tokens):
        window = tokens[cursor : cursor + max_words]
        if not window:
            break

        content = " ".join(token.word for token in window).strip()
        if content:
            section_counter = Counter(token.section for token in window if token.section)
            section = section_counter.most_common(1)[0][0] if section_counter else "Overview"
            chunks.append(
                ChunkRecord(
                    chunk_index=chunk_index,
                    section=section,
                    page_start=window[0].page_number,
                    page_end=window[-1].page_number,
                    token_count=len(window),
                    content=content,
                )
            )
            chunk_index += 1

        if cursor + max_words >= len(tokens):
            break
        cursor += step

    return chunks


def chunk_status(page_count: int, low_text_pages: list[int], chunk_count: int) -> str:
    if chunk_count <= 0:
        return "failed"
    ratio = (len(low_text_pages) / page_count) if page_count > 0 else 1.0
    if ratio > PARTIAL_LOW_TEXT_RATIO_THRESHOLD or chunk_count < MIN_CHUNK_THRESHOLD:
        return "partial"
    return "ready"


def require_env(name: str) -> str:
    value = os.getenv(name)
    if value:
        return value
    raise RuntimeError(f"Missing required environment variable: {name}")


@retry(wait=wait_exponential(multiplier=1, min=1, max=20), stop=stop_after_attempt(4), reraise=True)
def embed_batch(client: OpenAI, model: str, texts: list[str]) -> list[list[float]]:
    response = client.embeddings.create(model=model, input=texts)
    ordered = sorted(response.data, key=lambda row: row.index)
    return [row.embedding for row in ordered]


def get_existing_doc_for_hash(supabase: Client, source_key: str, source_sha256: str) -> dict[str, Any] | None:
    response = (
        supabase.table("manual_documents")
        .select("id,version,is_active")
        .eq("source_key", source_key)
        .eq("source_sha256", source_sha256)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    return rows[0] if rows else None


def get_next_version(supabase: Client, source_key: str) -> int:
    response = (
        supabase.table("manual_documents")
        .select("version")
        .eq("source_key", source_key)
        .order("version", desc=True)
        .limit(1)
        .execute()
    )
    rows = response.data or []
    if not rows:
        return 1
    return int(rows[0]["version"]) + 1


def insert_document_row(
    supabase: Client,
    source_key: str,
    source_filename: str,
    source_sha256: str,
    version: int,
    metadata: DocumentMetadata,
    page_count: int,
    extracted_word_count: int,
    status: str,
    warnings: list[str],
) -> str:
    payload = {
        "source_key": source_key,
        "source_filename": source_filename,
        "source_sha256": source_sha256,
        "version": version,
        "title": metadata.title,
        "product_domain": metadata.product_domain,
        "brand": metadata.brand,
        "model": metadata.model,
        "page_count": page_count,
        "extracted_word_count": extracted_word_count,
        "extraction_status": status,
        "extraction_warnings": warnings,
        "is_active": False,
        "updated_at": now_iso(),
    }
    response = supabase.table("manual_documents").insert(payload).execute()
    rows = response.data or []
    if not rows:
        raise RuntimeError(f"Insert failed for {source_key}: no row returned.")
    return str(rows[0]["id"])


def update_document_row(
    supabase: Client,
    document_id: str,
    metadata: DocumentMetadata,
    page_count: int,
    extracted_word_count: int,
    status: str,
    warnings: list[str],
    is_active: bool,
) -> None:
    payload = {
        "title": metadata.title,
        "product_domain": metadata.product_domain,
        "brand": metadata.brand,
        "model": metadata.model,
        "page_count": page_count,
        "extracted_word_count": extracted_word_count,
        "extraction_status": status,
        "extraction_warnings": warnings,
        "is_active": is_active,
        "updated_at": now_iso(),
    }
    supabase.table("manual_documents").update(payload).eq("id", document_id).execute()


def deactivate_other_versions(supabase: Client, source_key: str, current_document_id: str) -> None:
    supabase.table("manual_documents").update({"is_active": False, "updated_at": now_iso()}).eq("source_key", source_key).neq(
        "id", current_document_id
    ).eq("is_active", True).execute()


def replace_chunks_for_document(supabase: Client, document_id: str) -> None:
    supabase.table("manual_chunks").delete().eq("document_id", document_id).execute()


def upsert_chunk_rows(supabase: Client, rows: list[dict[str, Any]], batch_size: int) -> None:
    for batch in split_batches(rows, batch_size):
        supabase.table("manual_chunks").upsert(list(batch), on_conflict="source_ref").execute()


def validate_batch_sizes(embed_batch_size: int, upsert_batch_size: int, chunk_words: int, overlap_words: int) -> None:
    if embed_batch_size <= 0 or upsert_batch_size <= 0:
        raise RuntimeError("Batch sizes must be positive integers.")
    if chunk_words <= 0:
        raise RuntimeError("--chunk-words must be a positive integer.")
    if overlap_words < 0:
        raise RuntimeError("--overlap-words must be >= 0.")
    if overlap_words >= chunk_words:
        raise RuntimeError("--overlap-words must be smaller than --chunk-words.")


def main() -> int:
    args = parse_args()
    docs_dir = Path(args.docs_dir).resolve()
    repo_root = Path(__file__).resolve().parents[1]
    load_dotenv(repo_root / ".env")

    validate_batch_sizes(args.embed_batch_size, args.upsert_batch_size, args.chunk_words, args.overlap_words)

    if not docs_dir.exists() or not docs_dir.is_dir():
        print(f"[error] docs directory does not exist: {docs_dir}", file=sys.stderr)
        return 1

    pdf_files = sorted(path for path in docs_dir.iterdir() if path.is_file() and path.suffix.lower() == ".pdf")
    if not pdf_files:
        print(f"[error] no PDF files found in {docs_dir}", file=sys.stderr)
        return 1

    dry_run = bool(args.dry_run)
    force = bool(args.force)

    supabase: Client | None = None
    embedding_client: OpenAI | None = None
    embedding_model = os.getenv("EMBEDDINGS_MODEL", "text-embedding-3-small")

    if not dry_run:
        provider = os.getenv("EMBEDDINGS_PROVIDER", "openai").strip().lower()
        if provider != "openai":
            raise RuntimeError(f"Unsupported EMBEDDINGS_PROVIDER for this script: {provider}")

        supabase_url = require_env("SUPABASE_URL")
        supabase_key = require_env("SUPABASE_SERVICE_ROLE_KEY")
        embedding_api_key = require_env("EMBEDDINGS_API_KEY")

        supabase = create_client(supabase_url, supabase_key)
        embedding_client = OpenAI(api_key=embedding_api_key)

    totals = {
        "processed": 0,
        "skipped": 0,
        "failed": 0,
        "documents_written": 0,
        "chunks_written": 0,
    }

    for pdf_path in pdf_files:
        source_key = str(pdf_path.relative_to(repo_root)).replace(os.sep, "/")
        source_sha256 = sha256_file(pdf_path)
        source_filename = pdf_path.name
        existing_doc: dict[str, Any] | None = None

        if supabase is not None:
            existing_doc = get_existing_doc_for_hash(supabase, source_key, source_sha256)
            if existing_doc and bool(existing_doc.get("is_active")) and not force:
                totals["skipped"] += 1
                print(f"[skip] {source_filename}: active document already uses hash {source_sha256[:12]}")
                continue

        print(f"[parse] {source_filename}")
        try:
            pages = extract_page_records(pdf_path)
            metadata_title = extract_pdf_title(pdf_path)
            metadata = build_metadata(pdf_path, pages, metadata_title)
            tokens = build_token_stream(pages)
            chunks = build_chunks(tokens, max_words=args.chunk_words, overlap_words=args.overlap_words)
        except Exception as exc:
            totals["failed"] += 1
            print(f"[error] {source_filename}: parse failed: {exc}", file=sys.stderr)
            continue

        page_count = len(pages)
        extracted_word_count = sum(page.word_count for page in pages)
        low_text_pages = [page.page_number for page in pages if page.word_count < LOW_TEXT_PAGE_WORD_THRESHOLD]
        warnings: list[str] = []
        if low_text_pages:
            warnings.append(
                f"low_text_pages<{LOW_TEXT_PAGE_WORD_THRESHOLD}: " + ",".join(str(page_num) for page_num in low_text_pages)
            )
        status = chunk_status(page_count, low_text_pages, len(chunks))

        print(
            f"  pages={page_count} words={extracted_word_count} chunks={len(chunks)} "
            f"status={status} title={json.dumps(metadata.title)}"
        )

        if dry_run:
            totals["processed"] += 1
            continue

        assert supabase is not None
        assert embedding_client is not None

        try:
            if existing_doc:
                document_id = str(existing_doc["id"])
                version = int(existing_doc["version"])
                replace_chunks_for_document(supabase, document_id)
                update_document_row(
                    supabase=supabase,
                    document_id=document_id,
                    metadata=metadata,
                    page_count=page_count,
                    extracted_word_count=extracted_word_count,
                    status=status,
                    warnings=warnings,
                    is_active=False,
                )
            else:
                version = get_next_version(supabase, source_key)
                document_id = insert_document_row(
                    supabase=supabase,
                    source_key=source_key,
                    source_filename=source_filename,
                    source_sha256=source_sha256,
                    version=version,
                    metadata=metadata,
                    page_count=page_count,
                    extracted_word_count=extracted_word_count,
                    status=status,
                    warnings=warnings,
                )

            if not chunks:
                update_document_row(
                    supabase=supabase,
                    document_id=document_id,
                    metadata=metadata,
                    page_count=page_count,
                    extracted_word_count=extracted_word_count,
                    status="failed",
                    warnings=warnings + ["no_usable_chunks"],
                    is_active=False,
                )
                totals["failed"] += 1
                print(f"[warn] {source_filename}: no usable chunks, document marked failed.")
                continue

            doc_slug = slugify(pdf_path.stem)
            chunk_payloads: list[dict[str, Any]] = []
            chunk_texts = [chunk.content for chunk in chunks]
            embeddings: list[list[float]] = []

            for batch in split_batches(chunk_texts, args.embed_batch_size):
                embedded = embed_batch(embedding_client, embedding_model, list(batch))
                embeddings.extend(embedded)

            for idx, chunk in enumerate(chunks):
                source_ref = f"{doc_slug}:v{version}:p{chunk.page_start}-{chunk.page_end}:c{chunk.chunk_index}"
                chunk_payloads.append(
                    {
                        "product_domain": metadata.product_domain,
                        "brand": metadata.brand,
                        "model": metadata.model,
                        "section": chunk.section,
                        "source_ref": source_ref,
                        "content": chunk.content,
                        "embedding": embeddings[idx],
                        "document_id": document_id,
                        "chunk_index": chunk.chunk_index,
                        "page_start": chunk.page_start,
                        "page_end": chunk.page_end,
                        "token_count": chunk.token_count,
                    }
                )

            upsert_chunk_rows(supabase, chunk_payloads, args.upsert_batch_size)
            deactivate_other_versions(supabase, source_key, document_id)
            update_document_row(
                supabase=supabase,
                document_id=document_id,
                metadata=metadata,
                page_count=page_count,
                extracted_word_count=extracted_word_count,
                status=status,
                warnings=warnings,
                is_active=True,
            )

            totals["documents_written"] += 1
            totals["chunks_written"] += len(chunk_payloads)
            totals["processed"] += 1
            print(f"[ok] {source_filename}: version={version} chunks_upserted={len(chunk_payloads)}")
        except Exception as exc:
            totals["failed"] += 1
            print(f"[error] {source_filename}: ingest failed: {exc}", file=sys.stderr)
            continue

    print(
        "[done] "
        + " ".join(
            [
                f"processed={totals['processed']}",
                f"skipped={totals['skipped']}",
                f"failed={totals['failed']}",
                f"documents_written={totals['documents_written']}",
                f"chunks_written={totals['chunks_written']}",
            ]
        )
    )
    return 0 if totals["failed"] == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        raise SystemExit(1)
