import path from "node:path";
import { loadManualCorpus, retrieveProcedure, type ManualDocument, type RetrievalResult } from "@adio/core/server";
import { createLogger } from "../utils/logger";

const log = createLogger("manual-service");

export class ManualService {
  private corpus: ManualDocument[] = [];

  constructor(private readonly manualsDir: string) {}

  async init(): Promise<void> {
    const resolved = path.resolve(this.manualsDir);
    this.corpus = await loadManualCorpus(resolved);
    log.info("manuals_loaded", {
      manualsDir: resolved,
      documents: this.corpus.length
    });
  }

  lookup(query: string): RetrievalResult {
    return retrieveProcedure(query, this.corpus);
  }
}
