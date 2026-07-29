import { NextResponse } from "next/server";
import { runOwnerOpenAIHealthCheck } from "@/lib/ai/ownerHealth";

export const runtime = "nodejs";

/**
 * Owner-only OpenAI health endpoint (session cookies).
 * Returns only: erreichbar, modell, laufzeit_ms, fehlerkategorie.
 */
export async function POST() {
  try {
    const outcome = await runOwnerOpenAIHealthCheck();
    if (!outcome.ok && outcome.report == null) {
      const status =
        outcome.error === "Nicht angemeldet."
          ? 401
          : outcome.error.includes("Owner")
            ? 403
            : 400;
      return NextResponse.json(
        { error: outcome.error, report: null },
        { status },
      );
    }

    return NextResponse.json({
      erreichbar: outcome.report!.erreichbar,
      modell: outcome.report!.modell,
      laufzeit_ms: outcome.report!.laufzeit_ms,
      fehlerkategorie: outcome.report!.fehlerkategorie,
    });
  } catch {
    console.error("[api/internal/openai-health] unexpected failure");
    return NextResponse.json(
      {
        erreichbar: "nein",
        modell: null,
        laufzeit_ms: 0,
        fehlerkategorie: "unknown",
      },
      { status: 500 },
    );
  }
}
