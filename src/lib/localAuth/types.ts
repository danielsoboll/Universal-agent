
export type LocalRole = "admin" | "user";

export type LocalProject = {
  id: string;
  name: string;
  description: string;
  customer_id: string;
  system_id: string;
  /** Absolute path override; empty = LOCAL_DATA_ROOT */
  local_data_root: string;
  /** Relative under project folder, e.g. indexes/search */
  active_index_path: string;
  enabled_knowledge_unit_types: string[];
  created_at: string;
  updated_at: string;
};

export type LocalUser = {
  id: string;
  email: string;
  display_name: string;
  role: LocalRole;
  project_ids: string[];
  password_hash: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type LocalSession = {
  id: string;
  user_id: string;
  role: LocalRole;
  project_ids: string[];
  created_at: string;
  expires_at: string;
};

export type AskHistoryEntry = {
  id: string;
  user_id: string;
  project_id: string;
  question: string;
  answer: string;
  retrieval_summary: string;
  source_refs: Array<{
    rank: number;
    source_key: string;
    title: string;
    knowledge_unit_type: string;
    score: number;
  }>;
  model: string;
  token_usage: { input: number; output: number; embedding: number };
  estimated_cost: number;
  created_at: string;
};

export type SessionCookiePayload = {
  sid: string;
  uid: string;
  role: LocalRole;
  exp: number;
};
