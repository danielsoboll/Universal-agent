"use client";

import { useActionState } from "react";
import {
  createProject,
  type CreateProjectState,
} from "@/actions/projects";

const initialState: CreateProjectState = { error: null };

export function NewProjectForm() {
  const [state, formAction, pending] = useActionState(createProject, initialState);

  return (
    <form action={formAction} className="panel mt-6 space-y-4 p-6">
      {state.error ? (
        <p
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
          role="alert"
        >
          {state.error}
        </p>
      ) : null}
      <div>
        <label className="label" htmlFor="name">
          Name
        </label>
        <input className="input" id="name" name="name" required disabled={pending} />
      </div>
      <div>
        <label className="label" htmlFor="description">
          Beschreibung
        </label>
        <textarea
          className="textarea min-h-28"
          id="description"
          name="description"
          disabled={pending}
        />
      </div>
      <button className="btn btn-primary" type="submit" disabled={pending}>
        {pending ? "Wird angelegt…" : "Anlegen"}
      </button>
    </form>
  );
}
