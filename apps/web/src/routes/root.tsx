import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useSession, signOut } from "../auth.js";

export function RootLayout() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isPending && !session) void navigate({ to: "/sign-in" });
  }, [isPending, session, navigate]);

  if (isPending) return <p className="p-8 text-sm text-slate-500">Loading…</p>;
  if (!session) return null;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <nav className="flex gap-4 text-sm">
          <Link to="/" className="font-semibold">Fleet</Link>
        </nav>
        <button onClick={() => void signOut()} className="text-sm text-slate-600">
          Sign out
        </button>
      </header>
      <main className="p-6"><Outlet /></main>
    </div>
  );
}
