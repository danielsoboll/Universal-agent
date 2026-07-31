import { primaryCustomerId, requireAppAccess } from "@/lib/onboarding/access";
import { AskQuestionPanel } from "@/components/app/AskQuestionPanel";

export default async function AppAskPage() {
  const ctx = await requireAppAccess();
  const customerId = primaryCustomerId(ctx);

  return (
    <div className="space-y-4 sm:space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Fragen
        </h1>
        <p className="muted mt-1 text-sm">
          {ctx.customerName
            ? `Fragen zu ${ctx.customerName}`
            : "Fragen zu Ihrem System"}
        </p>
      </div>
      <AskQuestionPanel customerId={customerId} />
    </div>
  );
}
