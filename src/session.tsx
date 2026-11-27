import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";

export type OwnerProfile = { id: string; business_name: string; currency: string };
type SessionProps = {
  profile: OwnerProfile;
  signOut: () => Promise<void>;
  checkSession: () => Promise<void>;
};

export function SessionBoundary({ children }: { children: (session: SessionProps) => ReactNode }) {
  const [profile, setProfile] = useState<OwnerProfile | null>(null);
  const profileId = profile?.id;
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState("");
  const operation = useRef<Promise<void> | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  const checkSession = useCallback(() => {
    if (operation.current) return operation.current;
    const check = async () => {
      try {
        const response = await fetch("/api/session", { cache: "no-store" });
        if (response.ok) {
          setProfile((await response.json()).profile);
          setIssue("");
          return;
        }
        setProfile(null);
        setIssue(response.status === 401 ? "" : (await response.json()).error);
      } catch {
        setProfile(null);
        setIssue("The sign-in service is unavailable. Try again shortly.");
      } finally {
        setChecking(false);
      }
    };
    operation.current = check().finally(() => { operation.current = null; });
    return operation.current;
  }, []);

  useEffect(() => {
    void checkSession();
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("catalogue-session");
      channel.current.onmessage = () => void checkSession();
    }
    return () => channel.current?.close();
  }, [checkSession]);

  useEffect(() => {
    if (!profileId) return;
    const check = () => void checkSession();
    const timer = window.setInterval(check, 60000);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [profileId, checkSession]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operation.current) return;
    const form = event.currentTarget;
    const { email, password } = Object.fromEntries(new FormData(form));
    setBusy(true);
    setIssue("");
    operation.current = (async () => {
      try {
        const response = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error);
        form.reset();
        setProfile(result.profile);
        channel.current?.postMessage("changed");
      } catch (error) {
        setIssue(error instanceof Error ? error.message : "Could not sign in.");
      }
    })();
    await operation.current;
    operation.current = null;
    setBusy(false);
  }

  async function signOut() {
    if (operation.current) await operation.current;
    setChecking(true);
    setProfile(null);
    setIssue("");
    operation.current = (async () => {
      try {
        const response = await fetch("/api/session", { method: "DELETE" });
        channel.current?.postMessage("changed");
        if (!response.ok) setIssue((await response.json()).error);
      } catch {
        setIssue("Sign-out could not reach the server. Refresh and retry.");
      }
    })();
    await operation.current;
    operation.current = null;
    setChecking(false);
  }

  if (profile) return children({ profile, signOut, checkSession });
  return (
    <main className="session-page">
      <section className="panel sign-in" aria-labelledby="sign-in-title">
        <img src="/logo.png" alt="XL Traders" />
        <h1 id="sign-in-title">Admin sign in</h1>
        {checking ? <p role="status">Checking your session…</p> : (
          <form onSubmit={signIn}>
            <label>
              Email
              <input name="email" type="email" autoComplete="username" maxLength={254} required />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="current-password" maxLength={1024} required />
            </label>
            {issue && <p role="alert">{issue}</p>}
            <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
        )}
      </section>
    </main>
  );
}
