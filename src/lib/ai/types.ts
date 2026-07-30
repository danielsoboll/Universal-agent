import type { ZodType } from "zod";
import type { AIErrorCategory } from "@/lib/ai/errors";

export type ProviderHealthResult = {
  reachable: boolean;
  model: string;
  durationMs: number;
  errorCategory: AIErrorCategory | null;
  /** Short safe message — never includes API key or full provider payload */
  message: string;
};

export type GenerateStructuredInput<T> = {
  schema: ZodType<T>;
  schemaName: string;
  system?: string;
  user: string;
  model?: string;
  /** Optional per-call timeout (ms). Defaults to AI_CONFIG.timeoutMs. */
  timeoutMs?: number;
};

export type CreateEmbeddingsInput = {
  texts: string[];
  model?: string;
};

export interface AIProvider {
  readonly name: string;
  testConnection(): Promise<ProviderHealthResult>;
  generateStructured<T>(input: GenerateStructuredInput<T>): Promise<T>;
  createEmbeddings(input: CreateEmbeddingsInput): Promise<number[][]>;
}
