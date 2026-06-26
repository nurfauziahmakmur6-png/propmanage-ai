import { randomUUID } from "crypto";

// Correlation id minted at each entry point (upload, webhook, kb query) and threaded into
// job data + structured logs, so one request can be traced request -> queue -> job.
export function newRequestId(): string {
  return randomUUID();
}

export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}
