import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { AI_CONFIG } from "@/lib/ai/config";
import type { DomainProfile } from "@/lib/domain/types";
import {
  buildQueryPlanSchema,
  QUERY_PLAN_SCHEMA_VERSION,
  type QueryPlan,
} from "@/lib/knowledge/queryPlanSchema";
import type { ResolvedAskPrompt } from "@/lib/core/promptRegistry";

function buildUserPrompt(params: {
  question: string;
  availableTypes: string[];
  profile: DomainProfile;
}): string {
  return [
    "Erzeuge einen Suchplan für folgende Nutzerfrage:",
    "",
    params.question,
    "",
    "Aktuell verfügbare Knowledge-Unit-Typen:",
    params.availableTypes.join(", ") || "—",
    "",
    "Aktuell verfügbare Metadatenfelder:",
    params.profile.searchProfile.metadataFields.join(", ") || "—",
    "",
    "Erlaubte intent-Werte:",
    params.profile.intents.join(", "),
    "",
    "Erlaubte entity types:",
    params.profile.entityTypes.join(", "),
    "",
    "Erlaubte target_types:",
    params.profile.targetTypes.join(", "),
    "",
    "Erlaubte relation_expansion-Werte:",
    params.profile.relationExpansions.join(", "),
    "",
    "Erlaubte required_evidence-Werte:",
    params.profile.requiredEvidenceTypes.join(", "),
    "",
    `Domain Profile: ${params.profile.id}@${params.profile.version}`,
    `Antworte ausschließlich mit dem JSON-Schema ${QUERY_PLAN_SCHEMA_VERSION}.`,
  ].join("\n");
}

export type QueryPlannerResult =
  | {
      ok: true;
      plan: QueryPlan;
      token_usage: { input: number; output: number };
      model: string;
      repaired: boolean;
      prompt_key: string;
      prompt_version: string;
    }
  | {
      ok: false;
      message: string;
      token_usage: { input: number; output: number };
      model: string;
      prompt_key?: string;
      prompt_version?: string;
    };

async function callPlanner(params: {
  client: OpenAI;
  question: string;
  availableTypes: string[];
  profile: DomainProfile;
  systemPrompt: string;
  schema: ReturnType<typeof buildQueryPlanSchema>;
  repairHint?: string;
}): Promise<{
  raw: unknown;
  input: number;
  output: number;
}> {
  const user = buildUserPrompt({
    question: params.question,
    availableTypes: params.availableTypes,
    profile: params.profile,
  });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: user },
  ];
  if (params.repairHint) {
    messages.push({
      role: "user",
      content:
        "Das vorherige Ergebnis war ungültig. Erzeuge erneut ausschließlich gültiges JSON gemäß Schema. Hinweise: " +
        params.repairHint,
    });
  }

  const completion = await params.client.chat.completions.parse({
    model: AI_CONFIG.chatModel,
    messages,
    response_format: zodResponseFormat(params.schema, "query_plan_v1"),
    temperature: 0,
  });

  return {
    raw: completion.choices[0]?.message?.parsed ?? null,
    input: completion.usage?.prompt_tokens ?? 0,
    output: completion.usage?.completion_tokens ?? 0,
  };
}

/**
 * Builds a validated query plan using DomainProfile vocabulary + PromptRegistry text.
 * On invalid output: one repair attempt, then caller falls back to direct_rag.
 */
export async function planQuery(params: {
  question: string;
  availableKnowledgeUnitTypes: string[];
  domainProfile: DomainProfile;
  plannerPrompt: ResolvedAskPrompt;
}): Promise<QueryPlannerResult> {
  const model = AI_CONFIG.chatModel;
  const promptMeta = {
    prompt_key: params.plannerPrompt.key,
    prompt_version: params.plannerPrompt.version,
  };

  if (!process.env.OPENAI_API_KEY?.trim()) {
    return {
      ok: false,
      message: "OPENAI_API_KEY fehlt für KI-Tiefensuche.",
      token_usage: { input: 0, output: 0 },
      model,
      ...promptMeta,
    };
  }

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: AI_CONFIG.timeoutMs,
    maxRetries: AI_CONFIG.maxRetries,
  });

  const schema = buildQueryPlanSchema(params.domainProfile);
  let totalIn = 0;
  let totalOut = 0;

  try {
    const first = await callPlanner({
      client,
      question: params.question,
      availableTypes: params.availableKnowledgeUnitTypes,
      profile: params.domainProfile,
      systemPrompt: params.plannerPrompt.text,
      schema,
    });
    totalIn += first.input;
    totalOut += first.output;

    const parsed = schema.safeParse(first.raw);
    if (parsed.success) {
      return {
        ok: true,
        plan: {
          ...parsed.data,
          original_question:
            parsed.data.original_question.trim() || params.question,
        },
        token_usage: { input: totalIn, output: totalOut },
        model,
        repaired: false,
        ...promptMeta,
      };
    }

    const repair = await callPlanner({
      client,
      question: params.question,
      availableTypes: params.availableKnowledgeUnitTypes,
      profile: params.domainProfile,
      systemPrompt: params.plannerPrompt.text,
      schema,
      repairHint: parsed.error.message.slice(0, 800),
    });
    totalIn += repair.input;
    totalOut += repair.output;

    const repaired = schema.safeParse(repair.raw);
    if (repaired.success) {
      return {
        ok: true,
        plan: {
          ...repaired.data,
          original_question:
            repaired.data.original_question.trim() || params.question,
        },
        token_usage: { input: totalIn, output: totalOut },
        model,
        repaired: true,
        ...promptMeta,
      };
    }

    return {
      ok: false,
      message: repaired.error.message.slice(0, 400),
      token_usage: { input: totalIn, output: totalOut },
      model,
      ...promptMeta,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Query-Planner fehlgeschlagen.",
      token_usage: { input: totalIn, output: totalOut },
      model,
      ...promptMeta,
    };
  }
}
