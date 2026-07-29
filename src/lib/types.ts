export type ProjectMemberRole = "owner" | "editor" | "viewer";

export type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
};

export type ProjectMemberRow = {
  project_id: string;
  user_id: string;
  role: ProjectMemberRole;
  is_active: boolean;
};

export type SourceRow = {
  id: string;
  project_id: string;
  name: string;
  source_type: string;
  original_filename: string | null;
  storage_path: string | null;
  processing_status: string;
  created_at: string;
};
