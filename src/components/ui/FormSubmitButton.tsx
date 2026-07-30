"use client";

import { useFormStatus } from "react-dom";

export function FormSubmitButton({
  children,
  pendingLabel = "Bitte warten …",
  className = "btn btn-primary",
  disabled,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={className}
      disabled={disabled || pending}
      aria-busy={pending}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
