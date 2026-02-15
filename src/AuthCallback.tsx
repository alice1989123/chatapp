import { useEffect, useRef, useState } from "react";
import { userManager } from "./oidc";

export default function AuthCallback() {
  const [err, setErr] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      try {
        await userManager.signinRedirectCallback();
        window.location.replace("/");
      } catch (e: any) {
        console.error("signinRedirectCallback failed:", e);
        setErr(e?.message ?? String(e));
      }
    })();
  }, []);

  if (err) return <div style={{ padding: 24 }}>Auth callback error: {err}</div>;
  return <div style={{ padding: 24 }}>Completing sign-in…</div>;
}
