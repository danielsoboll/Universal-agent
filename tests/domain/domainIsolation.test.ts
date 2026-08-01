/**
 * Domain isolation tests (no OpenAI, no P01 data required).
 *   npx tsx tests/domain/domainIsolation.test.ts
 */
import assert from "assert";
import { resolveProjectCapabilities } from "../../src/lib/domain/capabilities";
import { resolveDomainProfile } from "../../src/lib/domain/registry";
import { buildQueryPlanSchema } from "../../src/lib/knowledge/queryPlanSchema";
import {
  resolvePromptEntry,
  resolveQueryPlannerPrompt,
  resolveAnswerSynthesizerPrompt,
} from "../../src/lib/core/promptRegistry";
import { resolveWorkflowTemplate } from "../../src/lib/domain/workflowTemplates";
import type { LocalProject } from "../../src/lib/localAuth/types";

function project(domain_profile_id: LocalProject["domain_profile_id"]): LocalProject {
  const now = new Date().toISOString();
  return {
    id: `proj-${domain_profile_id ?? "none"}`,
    name: "Test",
    description: "",
    customer_id: "T01",
    system_id: "S1",
    local_data_root: "",
    active_index_path: "indexes/search",
    enabled_knowledge_unit_types: [],
    domain_profile_id,
    created_at: now,
    updated_at: now,
  };
}

function testMissingProfileIsNotSap() {
  const profile = resolveDomainProfile(undefined);
  assert.equal(profile.id, "generic_documents");
  const caps = resolveProjectCapabilities(project(undefined));
  assert.equal(caps.domainProfileId, "generic_documents");
  assert.ok(!caps.entityTypes.includes("partner_role"));
  assert.ok(!caps.entityTypes.includes("customer_number"));
  console.log("ok missing profile → generic_documents (not sap)");
}

function testSapCapabilities() {
  const caps = resolveProjectCapabilities(project("sap"));
  assert.equal(caps.domainProfileId, "sap");
  assert.ok(caps.entityTypes.includes("customer_number"));
  assert.ok(caps.entityTypes.includes("partner_role"));
  assert.ok(caps.intentTypes.includes("customer_specific_logic"));
  assert.ok(caps.knowledgeUnitTypes.includes("code_unit"));
  assert.equal(caps.searchProfile.id, "search.sap.v1");
  assert.ok(caps.searchProfile.knowledgeUnitTypeBoosts.business_rule);
  assert.ok(caps.plannerPrompt.text.includes("SAP"));
  assert.ok(caps.answerPrompt.text.includes("SAP"));
  assert.equal(caps.workflowTemplateId, "sap_knowledge_reconstruction.v1");
  assert.ok(caps.workflowTemplate);
  assert.equal(caps.workflowTemplate!.domain_profile_id, "sap");
  console.log("ok SAP capabilities + prompts + workflow + search profile");
}

function testWebsiteIsolation() {
  const caps = resolveProjectCapabilities(project("website"));
  assert.equal(caps.domainProfileId, "website");
  assert.ok(!caps.entityTypes.includes("partner_role"));
  assert.ok(!caps.entityTypes.includes("customer_number"));
  assert.ok(!caps.entityTypes.includes("function_module"));
  assert.ok(!caps.intentTypes.includes("customer_specific_logic"));
  assert.ok(!caps.knowledgeUnitTypes.includes("code_unit"));
  assert.ok(caps.knowledgeUnitTypes.includes("web_page"));
  assert.ok(caps.plannerPrompt.domain_profile_id === "website");
  assert.ok(caps.answerPrompt.domain_profile_id === "website");
  assert.ok(caps.plannerPrompt.text.includes("Webseite"));
  assert.ok(!caps.plannerPrompt.text.includes("Partnerrolle"));
  assert.ok(!caps.plannerPrompt.text.includes("Steuertabellen"));
  assert.deepEqual(caps.searchProfile.knowledgeUnitTypeBoosts, {});
  assert.equal(caps.workflowTemplateId, "website_content_index.v1");
  console.log("ok Website isolation (no SAP vocab/prompts)");
}

function testDatabaseIsolation() {
  const caps = resolveProjectCapabilities(project("database"));
  assert.equal(caps.domainProfileId, "database");
  assert.ok(!caps.entityTypes.includes("partner_role"));
  assert.ok(!caps.entityTypes.includes("class"));
  assert.ok(!caps.intentTypes.includes("hardcoded_values"));
  assert.ok(caps.knowledgeUnitTypes.includes("db_table"));
  assert.ok(!caps.knowledgeUnitTypes.includes("code_unit"));
  assert.ok(caps.plannerPrompt.domain_profile_id === "database");
  assert.ok(caps.plannerPrompt.text.includes("Datenbank"));
  assert.ok(!caps.entityTypes.includes("function_module"));
  assert.equal(caps.workflowTemplateId, "database_schema_index.v1");
  console.log("ok Database isolation (no SAP vocab/prompts)");
}

function testQueryPlanSchemaIsProfileBound() {
  const sapSchema = buildQueryPlanSchema(resolveDomainProfile("sap"));
  const webSchema = buildQueryPlanSchema(resolveDomainProfile("website"));

  const sapOk = sapSchema.safeParse({
    schema_version: "query-plan-v1",
    original_question: "x",
    intent: "customer_specific_logic",
    entities: [{ type: "customer_name", value: "Acme", confidence: 0.9 }],
    subqueries: [
      {
        id: "q1",
        query: "acme",
        target_types: ["code_unit"],
        relation_expansion: "callers",
      },
    ],
  });
  assert.ok(sapOk.success, "SAP plan should accept SAP enums");

  const webRejectSap = webSchema.safeParse({
    schema_version: "query-plan-v1",
    original_question: "x",
    intent: "customer_specific_logic",
    entities: [{ type: "customer_name", value: "Acme" }],
    subqueries: [
      {
        id: "q1",
        query: "acme",
        target_types: ["code_unit"],
        relation_expansion: "callers",
      },
    ],
  });
  assert.ok(!webRejectSap.success, "Website schema must reject SAP enums");

  const webOk = webSchema.safeParse({
    schema_version: "query-plan-v1",
    original_question: "x",
    intent: "fact_lookup",
    entities: [{ type: "topic", value: "pricing" }],
    subqueries: [
      {
        id: "q1",
        query: "pricing",
        target_types: ["content_unit"],
        relation_expansion: "none",
      },
    ],
  });
  assert.ok(webOk.success, "Website plan should accept website enums");
  console.log("ok query-plan schema bound to domain profile");
}

function testPromptRegistryKeys() {
  assert.ok(resolvePromptEntry("query_planner.base", "v1").body);
  assert.equal(
    resolvePromptEntry("query_planner.sap", "v1").domain_profile_id,
    "sap",
  );
  assert.equal(
    resolvePromptEntry("query_planner.website", "v1").domain_profile_id,
    "website",
  );
  const composed = resolveQueryPlannerPrompt({
    domainPromptKey: "query_planner.database",
    domainPromptVersion: "v1",
  });
  assert.ok(composed.text.includes("Datenbank"));
  assert.ok(!composed.text.includes("Partnerrolle"));
  const answer = resolveAnswerSynthesizerPrompt({
    domainPromptKey: "answer_synthesizer.website",
    domainPromptVersion: "v1",
  });
  assert.ok(answer.text.includes("Webseite"));
  assert.equal(answer.domain_profile_id, "website");
  console.log("ok PromptRegistry keys + composition");
}

function testWorkflowTemplates() {
  const sap = resolveWorkflowTemplate("sap_knowledge_reconstruction.v1");
  assert.ok(sap);
  assert.ok(sap!.process.steps.length > 0);
  const web = resolveWorkflowTemplate("website_content_index.v1");
  assert.ok(web);
  assert.equal(web!.domain_profile_id, "website");
  console.log("ok Workflow templates registered");
}

function main() {
  testMissingProfileIsNotSap();
  testSapCapabilities();
  testWebsiteIsolation();
  testDatabaseIsolation();
  testQueryPlanSchemaIsProfileBound();
  testPromptRegistryKeys();
  testWorkflowTemplates();
  console.log("\nAll domain isolation tests passed.");
}

main();
