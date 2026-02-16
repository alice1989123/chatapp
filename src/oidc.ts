// src/auth/userManager.ts
import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const cognitoDomain =
  "https://us-east-1gx9karkqf.auth.us-east-1.amazoncognito.com";

// ✅ Single place to control local vs prod.
// In Amplify, set env var: VITE_APP_URL=https://main.dvy6izhvyc8pp.amplifyapp.com
// Locally, it will fall back to localhost.
const appUrl =
  (import.meta as any).env?.VITE_APP_URL?.replace(/\/+$/, "") ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.host}`
    : "http://localhost:5173");

export const userManager = new UserManager({
  authority: cognitoDomain,
  client_id: "f7ruoas63jkr161d2jc40e1i",

  // ✅ must match Cognito “Allowed callback URLs”
  redirect_uri: `${appUrl}/auth/callback`,

  response_type: "code",
  scope: "openid email",

  // optional but recommended for SPA
  // (Cognito allows refresh tokens only if you enabled it on the app client)
  // scope: "openid email offline_access",

  // 🚫 prevents discovery fetch (no CORS problem)
  metadata: {
    issuer: cognitoDomain,
    authorization_endpoint: `${cognitoDomain}/oauth2/authorize`,
    token_endpoint: `${cognitoDomain}/oauth2/token`,
    end_session_endpoint: `${cognitoDomain}/logout`,
    jwks_uri: `${cognitoDomain}/.well-known/jwks.json`,
  },

  userStore: new WebStorageStateStore({ store: window.localStorage }),

  // nice-to-haves (safe defaults)
  automaticSilentRenew: true,
  loadUserInfo: false,
});
