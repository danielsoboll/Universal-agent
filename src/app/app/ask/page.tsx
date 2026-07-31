import {
  primaryProjectId,
  requireLocalAppAccess,
} from "@/lib/localAuth/session";
import { AskQuestionPanel } from "@/components/app/AskQuestionPanel";

export default async function AppAskPage() {
  const ctx = await requireLocalAppAccess();
  const projectId = primaryProjectId(ctx.user);

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Fragen
        </h1>
        <p className="muted mt-1 text-sm">
          Freie Frage an den lokalen Wissensbestand — ohne fest verdrahtete
          Demo-Antworten.
        </p>
      </div>
      <AskQuestionPanel projectId={projectId} />
    </div>
  );
}
