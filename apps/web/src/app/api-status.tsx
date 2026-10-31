"use client";

import { HealthResponse } from "@ssdashboard/contracts";
import { useEffect, useState } from "react";

type State =
  | { kind: "loading" }
  | { kind: "ready"; health: HealthResponse }
  | { kind: "error"; message: string };

/** Calls the api through the relative `/api` path, the same way every install does. */
export function ApiStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`api answered ${response.status}`);
        setState({ kind: "ready", health: HealthResponse.parse(await response.json()) });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, []);

  return (
    <dl className="mt-6 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1" aria-live="polite">
      <dt className="font-medium">API</dt>
      <dd>{state.kind === "loading" ? "checking…" : state.kind === "error" ? `unreachable (${state.message})` : state.health.status}</dd>
      {state.kind === "ready" && (
        <>
          <dt className="font-medium">Database</dt>
          <dd>{state.health.database}</dd>
          <dt className="font-medium">Version</dt>
          <dd>{state.health.version}</dd>
        </>
      )}
    </dl>
  );
}
