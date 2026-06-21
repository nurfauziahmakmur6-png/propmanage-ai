import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { documents } from "../../db/schema";
import { enqueueIngestion, STUCK_TIMEOUT_MS } from "../queue/queues";
import type { LogFn } from "./pipeline";

/**
 * Re-enqueue documents left in `processing` past the timeout — the safety net for a
 * worker that crashed after setting `processing` but before finishing. Forced
 * re-enqueue clears a finished job in the same deterministic id so the document can be
 * re-driven; an in-flight pipeline is left untouched.
 */
export async function sweepStuckDocuments(log?: LogFn): Promise<number> {
  const cutoffSeconds = Math.floor(STUCK_TIMEOUT_MS / 1000);
  const stuck = await db
    .select({ id: documents.id, organizationId: documents.organizationId })
    .from(documents)
    .where(
      and(
        eq(documents.status, "processing"),
        sql`${documents.updatedAt}::timestamptz < now() - make_interval(secs => ${cutoffSeconds})`
      )
    );

  let reenqueued = 0;
  for (const doc of stuck) {
    const result = await enqueueIngestion(
      { documentId: doc.id, organizationId: doc.organizationId },
      { force: true }
    );
    if (result === "enqueued") reenqueued++;
    log?.("sweep.reenqueue", { documentId: doc.id, result });
  }
  if (stuck.length > 0) log?.("sweep.done", { found: stuck.length, reenqueued });
  return reenqueued;
}
