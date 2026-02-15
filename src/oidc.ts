import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const cognitoDomain =
  "https://us-east-1gx9karkqf.auth.us-east-1.amazoncognito.com";

export const userManager = new UserManager({
  authority: cognitoDomain,
  client_id: "f7ruoas63jkr161d2jc40e1i",
  redirect_uri: "http://localhost:5173/auth/callback",
  response_type: "code",
  scope: "openid email", // add profile later if enabled in Cognito

  // 🚫 prevents discovery fetch (no CORS problem)
  metadata: {
    issuer: cognitoDomain,
    authorization_endpoint: `${cognitoDomain}/oauth2/authorize`,
    token_endpoint: `${cognitoDomain}/oauth2/token`,
    end_session_endpoint: `${cognitoDomain}/logout`,
    jwks_uri: `${cognitoDomain}/.well-known/jwks.json`,
  },

  userStore: new WebStorageStateStore({ store: window.localStorage }),
});
