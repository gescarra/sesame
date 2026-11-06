import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { retryUnlessClientError } from "./queries.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: retryUnlessClientError, staleTime: 15_000 },
  },
});

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
