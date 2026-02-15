import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const cognitoDomain =
  "https://us-east-1gx9karkqf.auth.us-east-1.amazoncognito.com";
const userPoolIssuer =
  "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_GX9kaRKQF";

export const userManager = new UserManager({
  authority: userPoolIssuer,
  client_id: "f7ruoas63jkr161d2jc40e1i",
  redirect_uri: "http://localhost:5173/auth/callback",
  response_type: "code",
  scope: "openid email profile",

  // Use hosted UI endpoints (important!)
  metadata: {
    issuer: userPoolIssuer,
    authorization_endpoint: `${cognitoDomain}/oauth2/authorize`,
    token_endpoint: `${cognitoDomain}/oauth2/token`,
    end_session_endpoint: `${cognitoDomain}/logout`,
    jwks_uri: `${userPoolIssuer}/.well-known/jwks.json`,
  },

  // Avoid weird state issues across reloads
  userStore: new WebStorageStateStore({ store: window.localStorage }),
});
