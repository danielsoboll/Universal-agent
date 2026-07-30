import assert from "node:assert/strict";
import {
  generateCustomerWorkflow,
  matchesVisibleWhen,
  selectWorkflowTemplate,
  type WorkflowStepTemplateInput,
  type WorkflowTemplateInput,
} from "../../src/lib/onboarding/generateCustomerWorkflow";

const templates: WorkflowTemplateInput[] = [
  {
    id: "t-sap",
    template_key: "sap_knowledge_reconstruction",
    name: "SAP Knowledge Reconstruction",
    version: "1.0.0",
    goal_types: ["code_intelligence", "knowledge_reconstruction"],
    required_adapter_keys: ["sap_abap_repository"],
    optional_adapter_keys: ["sap_control_tables"],
    priority: 10,
    enabled: true,
  },
  {
    id: "t-doc",
    template_key: "document_knowledge_base",
    name: "Document Knowledge Base",
    version: "1.0.0",
    goal_types: ["knowledge_reconstruction", "enterprise_search"],
    required_adapter_keys: ["documents"],
    optional_adapter_keys: ["spreadsheets"],
    priority: 20,
    enabled: true,
  },
];

const sapSteps: WorkflowStepTemplateInput[] = [
  {
    id: "s1",
    step_key: "export_classes",
    phase_key: "datenexport",
    title: "Export",
    short_description: "",
    detailed_instructions: "",
    info_text: "",
    sort_order: 10,
    required: true,
    completion_type: "manual_checkbox",
    pipeline_step_key: null,
    adapter_key: "sap_abap_repository",
    visible_when: { all_adapters: ["sap_abap_repository"] },
    prerequisites: [],
    expected_outputs: [],
    estimated_effort_text: null,
    responsible_role: "customer_admin",
  },
  {
    id: "s2",
    step_key: "export_tables",
    phase_key: "datenexport",
    title: "Tables",
    short_description: "",
    detailed_instructions: "",
    info_text: "",
    sort_order: 20,
    required: true,
    completion_type: "manual_checkbox",
    pipeline_step_key: null,
    adapter_key: "sap_control_tables",
    visible_when: { all_adapters: ["sap_control_tables"] },
    prerequisites: ["export_classes"],
    expected_outputs: [],
    estimated_effort_text: null,
    responsible_role: "customer_admin",
  },
  {
    id: "s3",
    step_key: "link",
    phase_key: "verknuepfung_und_relationen",
    title: "Link",
    short_description: "",
    detailed_instructions: "",
    info_text: "",
    sort_order: 30,
    required: true,
    completion_type: "pipeline_success",
    pipeline_step_key: "link.code_control_tables",
    adapter_key: null,
    visible_when: {
      all_adapters: ["sap_abap_repository", "sap_control_tables"],
    },
    prerequisites: ["export_classes", "export_tables"],
    expected_outputs: [],
    estimated_effort_text: null,
    responsible_role: "customer_admin",
  },
];

{
  const t = selectWorkflowTemplate(templates, ["code_intelligence"], [
    "sap_abap_repository",
    "sap_control_tables",
  ]);
  assert.equal(t?.template_key, "sap_knowledge_reconstruction");
}

{
  const t = selectWorkflowTemplate(templates, ["enterprise_search"], ["documents"]);
  assert.equal(t?.template_key, "document_knowledge_base");
}

assert.equal(
  matchesVisibleWhen(
    { all_adapters: ["sap_control_tables"] },
    [],
    ["sap_abap_repository"],
  ),
  false,
);

{
  const result = generateCustomerWorkflow({
    customerId: "c1",
    goalTypes: ["code_intelligence"],
    adapterKeys: ["sap_abap_repository", "sap_control_tables"],
    templates,
    stepTemplatesByTemplateId: { "t-sap": sapSteps },
  });
  assert.equal(result.steps.length, 3);
  assert.ok(result.steps.find((s) => s.step_key === "link"));
  assert.equal(result.steps.find((s) => s.step_key === "export_classes")?.status, "ready");
  assert.equal(result.steps.find((s) => s.step_key === "link")?.status, "blocked");
}

{
  const result = generateCustomerWorkflow({
    customerId: "c1",
    goalTypes: ["code_intelligence"],
    adapterKeys: ["sap_abap_repository"],
    templates,
    stepTemplatesByTemplateId: { "t-sap": sapSteps },
  });
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].step_key, "export_classes");
}

console.log("PASS generateCustomerWorkflow tests");
