import type { AppConfig } from "../config";

interface OpenAiEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
}

export function canGenerateEmbeddings(config: AppConfig): boolean {
  return config.embeddingsProvider.toLowerCase() === "openai" && Boolean(config.embeddingsApiKey);
}

export async function embedTexts(texts: string[], config: AppConfig): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  if (config.embeddingsProvider.toLowerCase() !== "openai") {
    throw new Error(`Unsupported EMBEDDINGS_PROVIDER: ${config.embeddingsProvider}`);
  }

  if (!config.embeddingsApiKey) {
    throw new Error("EMBEDDINGS_API_KEY is required for openai embeddings.");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.embeddingsApiKey}`
    },
    body: JSON.stringify({
      model: config.embeddingsModel,
      input: texts
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding request failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as OpenAiEmbeddingResponse;
  const sorted = [...payload.data].sort((a, b) => a.index - b.index);

  if (sorted.length !== texts.length) {
    throw new Error(`Embedding count mismatch: expected ${texts.length}, received ${sorted.length}`);
  }

  return sorted.map((row) => row.embedding);
}
