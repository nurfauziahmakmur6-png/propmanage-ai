import { db } from "@/db";
import { eq, and, type SQL } from "drizzle-orm";
import {
  tickets,
  ticketMessages,
  properties,
  units,
  tenants,
  documents,
  documentChunks,
  inboundEmails,
  agentRuns,
  users,
} from "@/db/schema";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";

// Every business table has organization_id. This map lets withOrg resolve the
// column without the caller knowing its internal name.
const orgColumns = new Map<PgTable, PgColumn>([
  [tickets, tickets.organizationId],
  [ticketMessages, ticketMessages.organizationId],
  [properties, properties.organizationId],
  [units, units.organizationId],
  [tenants, tenants.organizationId],
  [documents, documents.organizationId],
  [documentChunks, documentChunks.organizationId],
  [inboundEmails, inboundEmails.organizationId],
  [agentRuns, agentRuns.organizationId],
  [users, users.organizationId],
]);

/**
 * Returns a scoped query builder for a single table, automatically injecting
 * the organization_id predicate so no handler can forget it.
 *
 * Usage:
 *   const rows = await withOrg(orgId, tickets).where(eq(tickets.status, "open"))
 */
export function withOrg(organizationId: string, table: PgTable) {
  const col = orgColumns.get(table);
  if (!col) {
    throw new Error(`withOrg: table "${table}" is not registered`);
  }
  return db.select().from(table).where(eq(col, organizationId));
}

/**
 * Combines the org predicate with additional caller-supplied conditions.
 * Use this when you need AND conditions beyond org scoping.
 *
 * Usage:
 *   const filter = withOrgFilter(orgId, tickets, eq(tickets.status, "open"))
 *   const rows = await db.select().from(tickets).where(filter)
 */
export function withOrgFilter(organizationId: string, table: PgTable, ...extra: SQL[]): SQL {
  const col = orgColumns.get(table);
  if (!col) {
    throw new Error(`withOrg: table "${table}" is not registered`);
  }
  const orgFilter = eq(col, organizationId);
  if (extra.length === 0) return orgFilter;
  return and(orgFilter, ...extra)!;
}
