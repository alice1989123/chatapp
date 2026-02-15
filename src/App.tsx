import { useAuth } from "react-oidc-context";
import AuthCallback from "./AuthCallback";
import ChatApp from "./ChatApp";

const cognitoDomain =
  "https://us-east-1gx9karkqf.auth.us-east-1.amazoncognito.com";
const clientId = "f7ruoas63jkr161d2jc40e1i";
const logoutUri = "http://localhost:5173/";

export default function App() {
  const auth = useAuth();

  const isCallback = window.location.pathname === "/auth/callback";
  if (isCallback) return <AuthCallback />;

  if (auth.isLoading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (auth.error) return <div style={{ padding: 24 }}>Error: {auth.error.message}</div>;

  if (!auth.isAuthenticated) {
    return (
      <div style={{ padding: 24 }}>
        <h2>Assistant App</h2>
        <button onClick={() => auth.signinRedirect()}>Sign in</button>
      </div>
    );
  }

  const signOutRedirect = () => {
    console.log("isAuthenticated", auth.isAuthenticated);
    console.log("has access token", Boolean(auth.user?.access_token));
    window.location.href =
      `${cognitoDomain}/logout?client_id=${clientId}&logout_uri=${encodeURIComponent(logoutUri)}`;
  };

  const accessToken = auth.user?.access_token ?? "";
  if (!accessToken) {
    return (
      <div style={{ padding: 24 }}>
        Signed in, but no access token found.
        <button onClick={() => auth.removeUser()}>Reset local session</button>{" "}
        <button onClick={signOutRedirect}>Cognito sign out</button>
      </div>
    );
  }

  return <ChatApp accessToken={accessToken} />;
}
