import type { HardcodedValueAnswerView } from "./types";

/** True when the client can render the hardcoded-value card panel. */
export function isUsableHardcodedValueAnswer(
  view: HardcodedValueAnswerView | null | undefined,
): view is HardcodedValueAnswerView {
  if (!view?.summary?.text?.trim()) return false;
  const materialCount =
    (view.materials?.length ?? 0) +
    (view.comment_or_unclear?.length ?? 0);
  return materialCount > 0 || view.summary.unique_material_count > 0;
}
