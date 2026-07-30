import type { ControlTableField } from "@/lib/ingest/controlTables/model";
import { normalizeCellValue } from "@/lib/ingest/controlTables/model";

export type InferredEntity = {
  entity_type: string;
  value: string;
  normalized_value: string;
  confidence: number;
  field_name: string;
};

function upper(s: string): string {
  return s.trim().toUpperCase();
}

/**
 * Generic entity typing from field metadata + value.
 * No concrete table/customer names hardcoded — only DDIC-like patterns.
 */
export function inferEntityFromField(params: {
  field: ControlTableField | null;
  fieldName: string;
  value: unknown;
  isKeyField: boolean;
}): InferredEntity | null {
  const value = normalizeCellValue(params.value);
  if (!value) return null;

  const fieldName = upper(params.fieldName);
  const de = upper(params.field?.data_element ?? "");
  const domain = upper(params.field?.domain ?? "");
  const dtype = upper(params.field?.data_type ?? "");
  const desc = upper(params.field?.description ?? "");
  const length = params.field?.length ?? 0;

  const tokenBlob = `${fieldName} ${de} ${domain} ${desc}`;

  // Skip empty / pure client markers as standalone business entities when not useful
  if (
    fieldName === "MANDT" ||
    de === "MANDT" ||
    domain === "MANDT" ||
    dtype === "CLNT"
  ) {
    return {
      entity_type: "client_id",
      value,
      normalized_value: value,
      confidence: 0.95,
      field_name: params.fieldName,
    };
  }

  if (
    /\b(MATNR|MATERIAL)\b/.test(tokenBlob) ||
    fieldName.includes("MATNR")
  ) {
    return {
      entity_type: "material_number",
      value,
      normalized_value: value.replace(/^0+/, "") || value,
      confidence: 0.85,
      field_name: params.fieldName,
    };
  }

  if (/\b(KUNNR|CUSTOMER|KUNDE)\b/.test(tokenBlob) || fieldName.includes("KUNNR")) {
    return {
      entity_type: "customer_number",
      value,
      normalized_value: value.replace(/^0+/, "") || value,
      confidence: 0.85,
      field_name: params.fieldName,
    };
  }

  if (/\b(LIFNR|VENDOR|LIEFERANT)\b/.test(tokenBlob) || fieldName.includes("LIFNR")) {
    return {
      entity_type: "vendor_number",
      value,
      normalized_value: value.replace(/^0+/, "") || value,
      confidence: 0.85,
      field_name: params.fieldName,
    };
  }

  if (
    /\b(RFCDEST|LOGSYS|DESTINATION|SYSID|SERVER|HOST)\b/.test(tokenBlob) ||
    /DEST|LOGSYS|RFC/.test(fieldName)
  ) {
    return {
      entity_type: "technical_system_name",
      value,
      normalized_value: upper(value),
      confidence: 0.8,
      field_name: params.fieldName,
    };
  }

  if (
    /\b(STATUS|STAT|STCD|STATE)\b/.test(tokenBlob) ||
    /(STATUS|STAT)$/.test(fieldName)
  ) {
    return {
      entity_type: "status_value",
      value,
      normalized_value: upper(value),
      confidence: 0.75,
      field_name: params.fieldName,
    };
  }

  if (
    /\b(PARAM|KEY|CODE|KZ|FLAG|IND|TYPE|ART)\b/.test(tokenBlob) ||
    /^(KEY|PARAM|VAL|CODE|KZ)/.test(fieldName)
  ) {
    const isParamish =
      /PARAM|KEY|VAL/.test(fieldName) || /PARAM|KEY/.test(tokenBlob);
    return {
      entity_type: isParamish ? "parameter_or_mapping_value" : "code_value",
      value,
      normalized_value: upper(value),
      confidence: params.isKeyField ? 0.8 : 0.7,
      field_name: params.fieldName,
    };
  }

  if (
    /\b(TEXT|DESCR|BEZEICH|NAME|VTEXT|REMARK|COMMENT)\b/.test(tokenBlob) ||
    /(TEXT|DESCR|NAME|BEZ)$/.test(fieldName) ||
    (dtype === "CHAR" && length >= 20)
  ) {
    return {
      entity_type: "description_text",
      value,
      normalized_value: value,
      confidence: 0.7,
      field_name: params.fieldName,
    };
  }

  if (params.isKeyField) {
    return {
      entity_type: "primary_key_value",
      value,
      normalized_value: upper(value),
      confidence: 0.9,
      field_name: params.fieldName,
    };
  }

  if (dtype === "CHAR" && length > 0 && length <= 10) {
    return {
      entity_type: "code_value",
      value,
      normalized_value: upper(value),
      confidence: 0.55,
      field_name: params.fieldName,
    };
  }

  return {
    entity_type: "field_value",
    value,
    normalized_value: value,
    confidence: 0.4,
    field_name: params.fieldName,
  };
}
