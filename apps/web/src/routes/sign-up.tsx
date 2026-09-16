import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { signUp } from "../auth.js";

export interface SignUpResult {
  error: { message?: string | undefined } | null;
}

// Presentational, same shape as SignInForm: no ambient dependency on the
// auth client, so it can be driven directly in tests with a mock.
export function SignUpForm({
  onSignUp,
}: {
  onSignUp: (name: string, email: string, password: string) => Promise<SignUpResult>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await onSignUp(name, email, password);
    setBusy(false);
    if (result.error) setError(result.error.message ?? "Could not create account");
  }

  return (
    <form onSubmit={submit} className="mx-auto mt-24 w-full max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Create your Model Hub account</h1>

      <div className="space-y-1">
        <label htmlFor="name" className="block text-sm">Name</label>
        <input
          id="name" type="text" value={name} required
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded border px-3 py-2"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="email" className="block text-sm">Email</label>
        <input
          id="email" type="email" value={email} required
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded border px-3 py-2"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="password" className="block text-sm">Password</label>
        <input
          id="password" type="password" value={password} required
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded border px-3 py-2"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">{error}</p>
      )}

      <button
        type="submit" disabled={busy}
        className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50"
      >
        {busy ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}

export function SignUpRoute() {
  const navigate = useNavigate();
  return (
    <SignUpForm
      onSignUp={async (name, email, password) => {
        const result = await signUp.email({ name, email, password });
        if (!result.error) await navigate({ to: "/" });
        return { error: result.error ?? null };
      }}
    />
  );
}
