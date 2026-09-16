import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { signIn } from "../auth.js";

export interface SignInResult {
  error: { message?: string | undefined } | null;
}

// Presentational: takes onSignIn and renders. No ambient dependency on the
// auth client, so tests can drive it directly with a mock.
export function SignInForm({
  onSignIn,
}: {
  onSignIn: (email: string, password: string) => Promise<SignInResult>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await onSignIn(email, password);
    setBusy(false);
    if (result.error) setError(result.error.message ?? "Could not sign in");
  }

  return (
    <form onSubmit={submit} className="mx-auto mt-24 w-full max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Sign in to Model Hub</h1>

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
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function SignInRoute() {
  const navigate = useNavigate();
  return (
    <SignInForm
      onSignIn={async (email, password) => {
        const result = await signIn.email({ email, password });
        if (!result.error) await navigate({ to: "/" });
        return { error: result.error ?? null };
      }}
    />
  );
}
