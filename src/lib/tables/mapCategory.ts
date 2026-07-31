import type {
  CanonicalTableClassification,
  CanonicalTableDefinition,
} from "@/lib/ingest/controlTables/model";
import type { TableCategory } from "@/lib/tables/types";

/**
 * Map DDIC + existing classification into a coarse generic category.
 * No invented business meaning — only labels already present in artifacts.
 */
export function mapTableCategory(params: {
  definition: CanonicalTableDefinition;
  classification: CanonicalTableClassification | null;
}): TableCategory {
  const cls = params.classification?.classification ?? "";
  const delivery = (params.definition.delivery_class || "").toUpperCase();
  const reasons = (params.classification?.reasons ?? []).join(" ").toUpperCase();
  const desc = `${params.definition.description} ${params.definition.table_name}`.toUpperCase();

  if (cls === "CUSTOMIZING_CONTROL_TABLE") {
    if (/STATUS|STAT/.test(desc) || /STATUS/.test(reasons)) return "status_table";
    if (/PARAM|STEUER|CONTROL/.test(desc) || delivery === "E" || delivery === "G") {
      return "parameter_table";
    }
    if (/MAP|ZUORD|UMSETZ/.test(desc)) return "mapping_table";
    if (delivery === "C") return "customizing_like";
    return "control_table";
  }

  if (cls === "REVIEW_CANDIDATE") {
    if (delivery === "C") return "configuration_table";
    return "unknown";
  }

  // NON_CONTROL_TABLE and fallbacks
  if (delivery === "A") {
    if (/STAMM|MASTER|KUND|PARTNER|MATERIAL/.test(desc)) return "master_data_like";
    return "transaction_data";
  }
  if (delivery === "L" || delivery === "W") return "technical_table";
  if (delivery === "C") return "customizing_like";
  return "unknown";
}

export function classificationConfidence(
  classification: CanonicalTableClassification | null,
): number {
  if (!classification) return 0;
  // Existing scores are roughly -40..+40 style; normalize softly to 0..1
  const raw = Number(classification.score ?? 0);
  const clamped = Math.max(-40, Math.min(40, raw));
  return Number(((clamped + 40) / 80).toFixed(3));
}
