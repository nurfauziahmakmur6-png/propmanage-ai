import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  date,
  jsonb,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

// pgvector type — drizzle-orm ships no built-in, so we declare it here
const vector = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      return value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map(Number);
    },
  })(name);

// Generated tsvector column helper
const tsvectorColumn = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// ---------------------------------------------------------------------------
// organizations
// ---------------------------------------------------------------------------
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull().default("staff"), // owner | manager | staff
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex("users_org_email_idx").on(t.organizationId, t.email)]
);

// ---------------------------------------------------------------------------
// properties
// ---------------------------------------------------------------------------
export const properties = pgTable("properties", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------
export const units = pgTable("units", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id")
    .notNull()
    .references(() => properties.id, { onDelete: "cascade" }),
  unitNumber: text("unit_number").notNull(),
  floor: integer("floor"),
  bedrooms: integer("bedrooms"),
  areaSqm: numeric("area_sqm", { precision: 8, scale: 2 }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});

// ---------------------------------------------------------------------------
// tenants
// ---------------------------------------------------------------------------
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  unitId: uuid("unit_id")
    .notNull()
    .references(() => units.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  leaseStart: date("lease_start"),
  leaseEnd: date("lease_end"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});

// ---------------------------------------------------------------------------
// tickets
// ---------------------------------------------------------------------------
export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => properties.id, {
      onDelete: "set null",
    }),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "set null" }),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    status: text("status").notNull().default("open"), // open | in_progress | waiting | closed
    priority: text("priority").notNull().default("normal"), // low | normal | high | urgent
    category: text("category"), // set by the agent
    source: text("source").notNull().default("web"), // web | email | api
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Hot path: org-scoped list filtered by status, sorted newest-first
    index("tickets_org_status_created_idx").on(
      t.organizationId,
      t.status,
      sql`${t.createdAt} desc`
    ),
    // Partial index keeps the common open-ticket scan small
    index("tickets_org_open_idx")
      .on(t.organizationId, sql`${t.createdAt} desc`)
      .where(sql`status in ('open','in_progress','waiting')`),
    // "My tickets" assignment view
    index("tickets_org_assigned_status_idx").on(t.organizationId, t.assignedTo, t.status),
  ]
);

// ---------------------------------------------------------------------------
// ticket_messages
// ---------------------------------------------------------------------------
export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    authorRole: text("author_role").notNull().default("staff"), // staff | tenant | agent
    body: text("body").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // FK join: loading messages for a ticket
    index("ticket_messages_ticket_id_idx").on(t.ticketId),
  ]
);

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------
export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  docType: text("doc_type"), // hausordnung | mietvertrag | nebenkosten | other
  storageKey: text("storage_key").notNull(), // R2 object key
  mimeType: text("mime_type").notNull(),
  status: text("status").notNull().default("pending"), // pending | processing | ready | failed
  error: text("error"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
  // Bumped on every status transition so the sweeper can find rows stuck in `processing`.
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
});

// ---------------------------------------------------------------------------
// document_chunks
// ---------------------------------------------------------------------------
export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    // generated always — managed by the DB migration, not Drizzle insert
    contentTsv: tsvectorColumn("content_tsv"),
    // 384 dims for the local bge-small-en-v1.5 embedder (was 1536 for OpenAI in M1)
    embedding: vector("embedding", 384),
    tokenCount: integer("token_count"),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [
    uniqueIndex("document_chunks_doc_chunk_idx").on(t.documentId, t.chunkIndex),
    // FK join: all chunks for a document
    index("document_chunks_document_id_idx").on(t.documentId),
    // HNSW vector index for cosine similarity search
    index("document_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    // GIN full-text index for hybrid keyword retrieval
    index("document_chunks_tsv_idx").using("gin", t.contentTsv),
  ]
);

// ---------------------------------------------------------------------------
// inbound_emails
// ---------------------------------------------------------------------------
export const inboundEmails = pgTable(
  "inbound_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(), // provider Message-ID for dedupe
    fromAddr: text("from_addr").notNull(),
    subject: text("subject"),
    body: text("body"),
    status: text("status").notNull().default("received"), // received | processed | failed
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    receivedAt: text("received_at")
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Deduplicate duplicate webhook deliveries from the email provider
    uniqueIndex("inbound_emails_org_msgid_idx").on(t.organizationId, t.messageId),
  ]
);

// ---------------------------------------------------------------------------
// agent_runs
// ---------------------------------------------------------------------------
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  status: text("status").notNull(), // succeeded | failed | escalated
  toolCalls: jsonb("tool_calls").notNull().default([]),
  output: text("output"),
  tokensUsed: integer("tokens_used"),
  latencyMs: integer("latency_ms"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});
