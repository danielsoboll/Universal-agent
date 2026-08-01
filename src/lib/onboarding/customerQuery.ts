import type { AccessContext } from "@/lib/onboarding/access";
import { accessibleCustomerIds } from "@/lib/onboarding/access";

/**
 * Restrict a customers query to projects the user may see.
 * General Admin / platform: no filter (caller sees all).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyCustomerScopeFilter<T extends { in: (column: string, values: string[]) => any }>(
  query: T,
  ctx: AccessContext,
): T {
  if (ctx.isPlatformAdmin || ctx.isGeneralAdmin) return query;
  const ids = accessibleCustomerIds(ctx);
  return query.in(
    "id",
    ids.length ? ids : ["00000000-0000-0000-0000-000000000000"],
  ) as T;
}
