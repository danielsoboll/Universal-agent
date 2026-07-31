"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { deleteCustomerAction } from "@/actions/onboarding";

function DeleteSubmit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-secondary border-[var(--danger,#b91c1c)] text-[var(--danger,#b91c1c)]"
      disabled={disabled || pending}
      aria-busy={pending}
    >
      {pending ? "Wird gelöscht …" : "Projekt endgültig löschen"}
    </button>
  );
}

export function DeleteCustomerForm({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const matches = confirmName.trim() === customerName;

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-secondary text-sm"
        onClick={() => setOpen(true)}
      >
        Projekt löschen
      </button>
    );
  }

  return (
    <form
      action={deleteCustomerAction}
      className="panel compact space-y-3 border-[var(--danger,#b91c1c)] p-3 sm:p-4"
      style={{ borderWidth: 1 }}
    >
      <input type="hidden" name="customer_id" value={customerId} />
      <p className="text-sm font-semibold">Projekt löschen</p>
      <p className="muted text-sm">
        Löscht „{customerName}“ inklusive Ziele, Adapter, Fahrplan, Uploads und
        Qualitätsgates. Nicht rückgängig machbar.
      </p>
      <div>
        <label className="label" htmlFor="confirm_name">
          Zur Bestätigung Projektnamen eingeben
        </label>
        <input
          id="confirm_name"
          name="confirm_name"
          className="input"
          value={confirmName}
          onChange={(e) => setConfirmName(e.target.value)}
          autoComplete="off"
          placeholder={customerName}
          required
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <DeleteSubmit disabled={!matches} />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setOpen(false);
            setConfirmName("");
          }}
        >
          Abbrechen
        </button>
      </div>
    </form>
  );
}
