import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { signIn, signUp } from "../auth.js";

type Field = "name" | "email" | "password";
export type AuthValues = Record<Field, string>;
export interface AuthResult { error: { message?: string | undefined } | null }

const INPUT_TYPES: Record<Field, string> = { name: "text", email: "email", password: "password" };
const LABELS: Record<Field, string> = { name: "Name", email: "Email", password: "Password" };

/**
 * Presentational form shared by sign-in and sign-up. Takes its submit
 * handler as a prop, so tests can drive it without the auth client.
 */
export function AuthForm({ title, fields, submitLabel, busyLabel, onSubmit }: {
  title: string;
  fields: Field[];
  submitLabel: string;
  busyLabel: string;
  onSubmit: (values: AuthValues) => Promise<AuthResult>;
}) {
  const [values, setValues] = useState<AuthValues>({ name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await onSubmit(values);
    setBusy(false);
    if (result.error) setError(result.error.message ?? `Could not ${submitLabel.toLowerCase()}`);
  }

  return (
    <form onSubmit={submit} className="mx-auto mt-24 w-full max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {fields.map((field) => (
        <div key={field} className="space-y-1">
          <label htmlFor={field} className="block text-sm">{LABELS[field]}</label>
          <input
            id={field} type={INPUT_TYPES[field]} value={values[field]} required
            onChange={(e) => setValues({ ...values, [field]: e.target.value })}
            className="w-full rounded border px-3 py-2"
          />
        </div>
      ))}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button
        type="submit" disabled={busy}
        className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50"
      >
        {busy ? busyLabel : submitLabel}
      </button>
    </form>
  );
}

/** Runs an auth call and navigates to the fleet on success. */
function useAuthSubmit(call: (values: AuthValues) => Promise<AuthResult>) {
  const navigate = useNavigate();
  return async (values: AuthValues): Promise<AuthResult> => {
    const result = await call(values);
    if (!result.error) await navigate({ to: "/" });
    return { error: result.error ?? null };
  };
}

export function SignInRoute() {
  const onSubmit = useAuthSubmit(({ email, password }) => signIn.email({ email, password }));
  return (
    <AuthForm
      title="Sign in to Model Hub" fields={["email", "password"]}
      submitLabel="Sign in" busyLabel="Signing in…" onSubmit={onSubmit}
    />
  );
}

export function SignUpRoute() {
  const onSubmit = useAuthSubmit(({ name, email, password }) => signUp.email({ name, email, password }));
  return (
    <AuthForm
      title="Create your Model Hub account" fields={["name", "email", "password"]}
      submitLabel="Create account" busyLabel="Creating account…" onSubmit={onSubmit}
    />
  );
}
