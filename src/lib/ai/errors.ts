export type AIErrorCategory =
  | "not_configured"
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "invalid_request"
  | "provider"
  | "unknown";

export class AIProviderError extends Error {
  readonly category: AIErrorCategory;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly provider: string;

  constructor(options: {
    message: string;
    category: AIErrorCategory;
    status?: number | null;
    retryable?: boolean;
    provider?: string;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "AIProviderError";
    this.category = options.category;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.provider = options.provider ?? "openai";
  }
}

export function categorizeOpenAIError(error: unknown): {
  category: AIErrorCategory;
  status: number | null;
  retryable: boolean;
  message: string;
} {
  if (error instanceof AIProviderError) {
    return {
      category: error.category,
      status: error.status,
      retryable: error.retryable,
      message: error.message,
    };
  }

  const anyErr = error as {
    status?: number;
    code?: string;
    message?: string;
    name?: string;
    cause?: { code?: string };
  };

  const status = typeof anyErr?.status === "number" ? anyErr.status : null;
  const code = String(anyErr?.code ?? anyErr?.cause?.code ?? "").toLowerCase();
  const rawMessage = String(anyErr?.message ?? "Unbekannter Provider-Fehler");
  // Never echo secrets if somehow present
  const message = rawMessage.replace(/sk-[a-zA-Z0-9_-]+/g, "[redacted]");

  if (
    code.includes("timeout") ||
    code === "etimedout" ||
    code === "abort" ||
    /timeout/i.test(message)
  ) {
    return { category: "timeout", status, retryable: true, message: "Zeitüberschreitung beim Provider." };
  }

  if (
    code === "enotfound" ||
    code === "econnrefused" ||
    code === "econnreset" ||
    code === "fetch failed" ||
    /network|fetch failed|econn/i.test(message)
  ) {
    return { category: "network", status, retryable: true, message: "Netzwerkfehler zum Provider." };
  }

  if (status === 401 || status === 403) {
    return { category: "auth", status, retryable: false, message: "Provider-Authentifizierung fehlgeschlagen." };
  }

  if (status === 429) {
    return { category: "rate_limit", status, retryable: true, message: "Provider-Rate-Limit erreicht." };
  }

  if (status === 400 || status === 422) {
    return { category: "invalid_request", status, retryable: false, message: "Ungültige Provider-Anfrage." };
  }

  if (status != null && status >= 500) {
    return { category: "provider", status, retryable: true, message: "Temporärer Provider-Fehler." };
  }

  return { category: "unknown", status, retryable: false, message };
}
