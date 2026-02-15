import React from "react";
import ReactDOM from "react-dom/client";
import { AuthProvider } from "react-oidc-context";
import App from "./App";
import "./index.css";
import { userManager } from "./oidc";
import "@assistant-ui/react-ui/styles/index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider userManager={userManager}>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
