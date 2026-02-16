// src/App.tsx  (minimal changes: compute baseUrl from current host)
import { useAuth } from "react-oidc-context";
import AuthCallback from "./AuthCallback";
import ChatApp from "./ChatApp";

const cognitoDomain =
  "https://us-east-1gx9karkqf.auth.us-east-1.amazoncognito.com";
const clientId = "f7ruoas63jkr161d2jc40e1i";

export default function App() {
  const auth = useAuth();

  // ✅ Works on localhost AND Amplify automatically
  const baseUrl = `${window.location.protocol}//${window.location.host}`;
  const logoutUri = `${baseUrl}/`;

  const isCallback = window.location.pathname === "/auth/callback";
  if (isCallback) return <AuthCallback />;

  if (auth.isLoading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (auth.error)
    return <div style={{ padding: 24 }}>Error: {auth.error.message}</div>;

  if (!auth.isAuthenticated) {
    return (
      <div style={{ padding: 24 }}>
        <h2>Assistant App</h2>
        <button onClick={() => auth.signinRedirect()}>Sign in</button>
      </div>
    );
  }

  const signOutRedirect = () => {
    window.location.href =
      `${cognitoDomain}/logout?client_id=${clientId}` +
      `&logout_uri=${encodeURIComponent(logoutUri)}`;
  };

  const accessToken = auth.user?.access_token ?? "";
  const idToken = auth.user?.id_token ?? "";

  if (!accessToken || !idToken) {
    return (
      <div style={{ padding: 24 }}>
        Signed in, but missing token(s).
        <div style={{ marginTop: 8, fontFamily: "monospace", fontSize: 12 }}>
          access_token: {accessToken ? `len ${accessToken.length}` : "MISSING"}
          <br />
          id_token: {idToken ? `len ${idToken.length}` : "MISSING"}
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={() => auth.removeUser()}>Reset local session</button>{" "}
          <button onClick={signOutRedirect}>Cognito sign out</button>
        </div>
      </div>
    );
  }

  return <ChatApp accessToken={accessToken} idToken={idToken} />;
}
