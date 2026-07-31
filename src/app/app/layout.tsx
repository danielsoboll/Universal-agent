import {
  primaryProjectId,
  requireLocalAppAccess,
} from "@/lib/localAuth/session";
import { fileProjectRepository } from "@/lib/localAuth/projectRepository";
import { LocalAppShell } from "@/components/local/LocalAppShell";

export default async function AppAreaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await requireLocalAppAccess();
  const projectId = primaryProjectId(ctx.user);
  const project = projectId
    ? await fileProjectRepository.getById(projectId)
    : null;

  return (
    <LocalAppShell
      email={ctx.user.email}
      agentTitle={project?.name ?? "General Agent"}
    >
      {children}
    </LocalAppShell>
  );
}
