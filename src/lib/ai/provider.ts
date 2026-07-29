import "server-only";

import { AI_CONFIG } from "@/lib/ai/config";
import { OpenAIProvider } from "@/lib/ai/openaiProvider";
import type { AIProvider } from "@/lib/ai/types";

let cached: AIProvider | null = null;

/** Factory — swap provider implementation here without touching feature code. */
export function getAIProvider(): AIProvider {
  if (cached) return cached;

  switch (AI_CONFIG.provider) {
    case "openai":
      cached = new OpenAIProvider();
      break;
    default: {
      const _exhaustive: never = AI_CONFIG.provider;
      throw new Error(`Unsupported AI provider: ${String(_exhaustive)}`);
    }
  }

  return cached;
}

/** Test helper — clears singleton between checks. */
export function resetAIProviderCache(): void {
  cached = null;
}
