import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { AI_CONFIG } from "@/lib/ai/config";
import {
  AIProviderError,
  categorizeOpenAIError,
} from "@/lib/ai/errors";
import type {
  AIProvider,
  CreateEmbeddingsInput,
  GenerateStructuredInput,
  ProviderHealthResult,
} from "@/lib/ai/types";

function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new AIProviderError({
      message: "OPENAI_API_KEY nicht konfiguriert",
      category: "not_configured",
      retryable: false,
    });
  }
  return key;
}

function createOpenAIClient(): OpenAI {
  // Lazily constructed only when a method is called — never at import/build time.
  return new OpenAI({
    apiKey: requireApiKey(),
    timeout: AI_CONFIG.timeoutMs,
    maxRetries: AI_CONFIG.maxRetries,
  });
}

function toProviderError(error: unknown): AIProviderError {
  if (error instanceof AIProviderError) return error;
  const info = categorizeOpenAIError(error);
  return new AIProviderError({
    message: info.message,
    category: info.category,
    status: info.status,
    retryable: info.retryable,
    cause: error,
  });
}

export class OpenAIProvider implements AIProvider {
  readonly name = AI_CONFIG.provider;

  async testConnection(): Promise<ProviderHealthResult> {
    const model = AI_CONFIG.chatModel;
    const started = Date.now();

    if (!process.env.OPENAI_API_KEY?.trim()) {
      return {
        reachable: false,
        model,
        durationMs: Date.now() - started,
        errorCategory: "not_configured",
        message: "OPENAI_API_KEY nicht konfiguriert",
      };
    }

    try {
      const client = createOpenAIClient();
      // Smallest practical authenticated call — no product data.
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_completion_tokens: 1,
        temperature: 0,
      });

      const durationMs = Date.now() - started;
      void response.id;

      return {
        reachable: true,
        model,
        durationMs,
        errorCategory: null,
        message: "Provider erreichbar.",
      };
    } catch (error) {
      const durationMs = Date.now() - started;
      const mapped = toProviderError(error);
      console.error("[OpenAIProvider.testConnection] failed", {
        category: mapped.category,
        status: mapped.status,
        durationMs,
        // never log key or full response body
      });
      return {
        reachable: false,
        model,
        durationMs,
        errorCategory: mapped.category,
        message:
          mapped.category === "not_configured"
            ? "OPENAI_API_KEY nicht konfiguriert"
            : mapped.message,
      };
    }
  }

  async generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T> {
    const model = input.model ?? AI_CONFIG.chatModel;

    try {
      const client = createOpenAIClient();
      const completion = await client.chat.completions.parse({
        model,
        messages: [
          ...(input.system
            ? [{ role: "system" as const, content: input.system }]
            : []),
          { role: "user", content: input.user },
        ],
        response_format: zodResponseFormat(input.schema, input.schemaName),
      });

      const parsed = completion.choices[0]?.message?.parsed;
      if (parsed == null) {
        throw new AIProviderError({
          message: "Strukturierte Antwort fehlt.",
          category: "provider",
          retryable: true,
        });
      }
      return parsed as T;
    } catch (error) {
      const mapped = toProviderError(error);
      console.error("[OpenAIProvider.generateStructured] failed", {
        category: mapped.category,
        status: mapped.status,
        schemaName: input.schemaName,
        model,
      });
      throw mapped;
    }
  }

  async createEmbeddings(input: CreateEmbeddingsInput): Promise<number[][]> {
    const model = input.model ?? AI_CONFIG.embeddingModel;
    if (input.texts.length === 0) return [];

    try {
      const client = createOpenAIClient();
      const response = await client.embeddings.create({
        model,
        input: input.texts,
        dimensions: AI_CONFIG.embeddingDimensions,
      });

      const byIndex = [...response.data].sort((a, b) => a.index - b.index);
      return byIndex.map((row) => {
        if (row.embedding.length !== AI_CONFIG.embeddingDimensions) {
          throw new AIProviderError({
            message: `Unerwartete Embedding-Dimension ${row.embedding.length}.`,
            category: "provider",
            retryable: false,
          });
        }
        return row.embedding;
      });
    } catch (error) {
      const mapped = toProviderError(error);
      console.error("[OpenAIProvider.createEmbeddings] failed", {
        category: mapped.category,
        status: mapped.status,
        model,
        count: input.texts.length,
      });
      throw mapped;
    }
  }
}
