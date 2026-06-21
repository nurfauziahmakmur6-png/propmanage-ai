import Link from "next/link";
import { db } from "@/db";
import { tickets, properties, tenants, users } from "@/db/schema";
import { withOrgFilter } from "@/lib/withOrg";
import { eq, lt, desc, and } from "drizzle-orm";

// For Milestone 1, the org is hardcoded to the seed org.
// Replace with session.user.organizationId once auth is wired up.
const DEMO_ORG_ID = process.env.DEMO_ORG_ID ?? "";

const PAGE_SIZE = 20;

const STATUS_COLORS: Record<string, string> = {
  open: "bg-green-100 text-green-800",
  in_progress: "bg-blue-100 text-blue-800",
  waiting: "bg-yellow-100 text-yellow-800",
  closed: "bg-gray-100 text-gray-600",
};

const PRIORITY_COLORS: Record<string, string> = {
  low: "text-gray-500",
  normal: "text-gray-700",
  high: "text-orange-600",
  urgent: "text-red-600 font-semibold",
};

interface PageProps {
  searchParams: Promise<{ cursor?: string; status?: string }>;
}

export default async function TicketsPage({ searchParams }: PageProps) {
  const { cursor, status } = await searchParams;

  // Keyset pagination: cursor is the created_at of the last row on the previous page.
  // We fetch PAGE_SIZE + 1 to know whether a next page exists.
  const baseFilter = withOrgFilter(
    DEMO_ORG_ID,
    tickets,
    ...(status ? [eq(tickets.status, status)] : []),
    ...(cursor ? [lt(tickets.createdAt, cursor)] : [])
  );

  const rows = await db
    .select({
      id: tickets.id,
      title: tickets.title,
      status: tickets.status,
      priority: tickets.priority,
      category: tickets.category,
      createdAt: tickets.createdAt,
      propertyName: properties.name,
      tenantName: tenants.name,
      assigneeName: users.name,
    })
    .from(tickets)
    .leftJoin(properties, eq(tickets.propertyId, properties.id))
    .leftJoin(tenants, eq(tickets.tenantId, tenants.id))
    .leftJoin(users, eq(tickets.assignedTo, users.id))
    .where(baseFilter)
    .orderBy(desc(tickets.createdAt))
    .limit(PAGE_SIZE + 1);

  const hasNextPage = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const nextCursor = hasNextPage ? page[page.length - 1].createdAt : null;

  const statusOptions = ["open", "in_progress", "waiting", "closed"];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Tickets</h1>
        <span className="text-sm text-gray-500">{page.length} shown</span>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 mb-6">
        <Link
          href="/tickets"
          className={`px-3 py-1.5 rounded text-sm ${!status ? "bg-blue-600 text-white" : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"}`}
        >
          All
        </Link>
        {statusOptions.map((s) => (
          <Link
            key={s}
            href={`/tickets?status=${s}`}
            className={`px-3 py-1.5 rounded text-sm ${status === s ? "bg-blue-600 text-white" : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"}`}
          >
            {s.replace("_", " ")}
          </Link>
        ))}
      </div>

      {page.length === 0 ? (
        <p className="text-gray-500 text-center py-16">No tickets found.</p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
          {page.map((t) => (
            <Link
              key={t.id}
              href={`/tickets/${t.id}`}
              className="flex items-start gap-4 px-5 py-4 hover:bg-gray-50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900 truncate">{t.title}</p>
                <p className="text-sm text-gray-500 mt-0.5">
                  {t.propertyName ?? "No property"}
                  {t.tenantName ? ` · ${t.tenantName}` : ""}
                  {t.category ? ` · ${t.category}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span
                  className={`text-xs font-medium ${PRIORITY_COLORS[t.priority] ?? "text-gray-700"}`}
                >
                  {t.priority}
                </span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[t.status] ?? "bg-gray-100 text-gray-600"}`}
                >
                  {t.status.replace("_", " ")}
                </span>
                <span className="text-xs text-gray-400 w-32 text-right">
                  {new Date(t.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Keyset pagination controls */}
      {hasNextPage && nextCursor && (
        <div className="mt-6 text-center">
          <Link
            href={`/tickets?${status ? `status=${status}&` : ""}cursor=${encodeURIComponent(nextCursor)}`}
            className="inline-block px-4 py-2 border border-gray-300 rounded text-sm text-gray-700 hover:bg-gray-50"
          >
            Load more
          </Link>
        </div>
      )}
    </div>
  );
}
