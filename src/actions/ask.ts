"use server";

export type AskQuestionInput = {
  question: string;
  customerId?: string | null;
};

export type AskEvidenceRef = {
  title: string;
  sourceKey?: string;
  snippet?: string;
};

export type AskQuestionResult = {
  status: "not_connected" | "ok" | "error";
  answer: string | null;
  evidence: AskEvidenceRef[];
  message: string;
};

/**
 * Platzhalter für spätere Anbindung an hybridSearch / answerQuestion.
 * Keine Fake-Treffer, keine Demo-Sonderlogik.
 */
export async function askQuestionAction(
  input: AskQuestionInput,
): Promise<AskQuestionResult> {
  const question = input.question.trim();
  if (!question) {
    return {
      status: "error",
      answer: null,
      evidence: [],
      message: "Bitte eine Frage eingeben.",
    };
  }

  // Interface-ready hook — noch nicht an Search/LLM angebunden.
  void input.customerId;
  return {
    status: "not_connected",
    answer: null,
    evidence: [],
    message: "Die Wissenssuche ist noch nicht verbunden.",
  };
}
