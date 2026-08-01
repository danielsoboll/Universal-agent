import { primaryCustomerId, requireAppAccess } from "@/lib/onboarding/access";
import { AskQuestionPanel } from "@/components/app/AskQuestionPanel";
import { EmptyState } from "@/components/ui/states";

export default async function AppAskPage() {
  const ctx = await requireAppAccess();
  const customerId = primaryCustomerId(ctx);

  if (!customerId) {
    return (
      <EmptyState
        title="Kein Projekt"
        message="Fragen sind erst möglich, wenn Sie einem Projekt zugeordnet sind."
        actionHref="/"
        actionLabel="Zur Startseite"
      />
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Fragen
        </h1>
      </div>
      <AskQuestionPanel customerId={customerId} />
    </div>
  );
}
