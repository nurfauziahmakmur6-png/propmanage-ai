import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../db/schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema });

async function seed() {
  console.log("Seeding database...");

  // Organization
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Sunrise Property Management" })
    .returning();
  console.log(`Created org: ${org.id}`);

  // Write org ID to .env.local for the UI — always overwrite to stay in sync
  const { writeFileSync, existsSync, readFileSync } = await import("fs");
  const envPath = ".env.local";
  let envContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (/^DEMO_ORG_ID=.*/m.test(envContent)) {
    envContent = envContent.replace(/^DEMO_ORG_ID=.*/m, `DEMO_ORG_ID=${org.id}`);
  } else {
    envContent += `\nDEMO_ORG_ID=${org.id}\n`;
  }
  writeFileSync(envPath, envContent);

  // Users
  const [alice, bob, carol] = await db
    .insert(schema.users)
    .values([
      { organizationId: org.id, email: "alice@sunrise.pm", name: "Alice Chen", role: "manager" },
      { organizationId: org.id, email: "bob@sunrise.pm", name: "Bob Rivera", role: "staff" },
      { organizationId: org.id, email: "carol@sunrise.pm", name: "Carol Smith", role: "staff" },
    ])
    .returning();

  // Properties
  const [oakwood, riverside] = await db
    .insert(schema.properties)
    .values([
      {
        organizationId: org.id,
        name: "Oakwood Apartments",
        address: "142 Oakwood Drive, Austin TX 78701",
      },
      {
        organizationId: org.id,
        name: "Riverside Lofts",
        address: "900 Riverside Blvd, Austin TX 78702",
      },
    ])
    .returning();

  // Units
  const [oak1A, oak1B, oak2A, river101, river102] = await db
    .insert(schema.units)
    .values([
      { organizationId: org.id, propertyId: oakwood.id, unitNumber: "1A", floor: 1, bedrooms: 1, areaSqm: "52.00" },
      { organizationId: org.id, propertyId: oakwood.id, unitNumber: "1B", floor: 1, bedrooms: 2, areaSqm: "74.00" },
      { organizationId: org.id, propertyId: oakwood.id, unitNumber: "2A", floor: 2, bedrooms: 1, areaSqm: "52.00" },
      { organizationId: org.id, propertyId: riverside.id, unitNumber: "101", floor: 1, bedrooms: 2, areaSqm: "88.00" },
      { organizationId: org.id, propertyId: riverside.id, unitNumber: "102", floor: 1, bedrooms: 3, areaSqm: "110.00" },
    ])
    .returning();

  // Tenants
  const [tenantA, tenantB, tenantC, tenantD, tenantE] = await db
    .insert(schema.tenants)
    .values([
      { organizationId: org.id, unitId: oak1A.id, name: "Maria Santos", email: "maria@example.com", phone: "512-555-0101", leaseStart: "2024-01-01", leaseEnd: "2024-12-31" },
      { organizationId: org.id, unitId: oak1B.id, name: "James Park", email: "james@example.com", phone: "512-555-0102", leaseStart: "2024-03-01", leaseEnd: "2025-02-28" },
      { organizationId: org.id, unitId: oak2A.id, name: "Priya Nair", email: "priya@example.com", phone: "512-555-0103", leaseStart: "2023-09-01", leaseEnd: "2024-08-31" },
      { organizationId: org.id, unitId: river101.id, name: "Tom Adeyemi", email: "tom@example.com", phone: "512-555-0104", leaseStart: "2024-06-01", leaseEnd: "2025-05-31" },
      { organizationId: org.id, unitId: river102.id, name: "Lisa Huang", email: "lisa@example.com", phone: "512-555-0105", leaseStart: "2024-02-01", leaseEnd: "2025-01-31" },
    ])
    .returning();

  // Tickets (10 across different statuses and priorities)
  const ticketData = [
    {
      organizationId: org.id,
      propertyId: oakwood.id,
      unitId: oak1A.id,
      tenantId: tenantA.id,
      title: "Leaking faucet in kitchen",
      status: "open",
      priority: "high",
      category: "plumbing",
      source: "web",
      assignedTo: bob.id,
    },
    {
      organizationId: org.id,
      propertyId: oakwood.id,
      unitId: oak1B.id,
      tenantId: tenantB.id,
      title: "Heating unit not working — temperature below 15°C",
      status: "in_progress",
      priority: "urgent",
      category: "hvac",
      source: "email",
      assignedTo: carol.id,
    },
    {
      organizationId: org.id,
      propertyId: oakwood.id,
      unitId: oak2A.id,
      tenantId: tenantC.id,
      title: "Front door lock is stiff",
      status: "open",
      priority: "normal",
      category: "security",
      source: "web",
      assignedTo: bob.id,
    },
    {
      organizationId: org.id,
      propertyId: riverside.id,
      unitId: river101.id,
      tenantId: tenantD.id,
      title: "Broken window latch on second bedroom",
      status: "waiting",
      priority: "high",
      category: "windows",
      source: "web",
      assignedTo: carol.id,
    },
    {
      organizationId: org.id,
      propertyId: riverside.id,
      unitId: river102.id,
      tenantId: tenantE.id,
      title: "Smoke detector battery low",
      status: "open",
      priority: "high",
      category: "safety",
      source: "web",
      assignedTo: bob.id,
    },
    {
      organizationId: org.id,
      propertyId: oakwood.id,
      unitId: oak1A.id,
      tenantId: tenantA.id,
      title: "Question about rubbish bin schedule",
      status: "closed",
      priority: "low",
      category: "general",
      source: "email",
      assignedTo: alice.id,
    },
    {
      organizationId: org.id,
      propertyId: riverside.id,
      unitId: river101.id,
      tenantId: tenantD.id,
      title: "Mold spot appearing on bathroom ceiling",
      status: "open",
      priority: "urgent",
      category: "mold",
      source: "web",
      assignedTo: carol.id,
    },
    {
      organizationId: org.id,
      propertyId: oakwood.id,
      unitId: oak1B.id,
      tenantId: tenantB.id,
      title: "Parking space reassignment request",
      status: "closed",
      priority: "low",
      category: "parking",
      source: "web",
      assignedTo: alice.id,
    },
    {
      organizationId: org.id,
      propertyId: riverside.id,
      unitId: river102.id,
      tenantId: tenantE.id,
      title: "Dishwasher not draining properly",
      status: "in_progress",
      priority: "normal",
      category: "appliances",
      source: "web",
      assignedTo: bob.id,
    },
    {
      organizationId: org.id,
      propertyId: oakwood.id,
      unitId: oak2A.id,
      tenantId: tenantC.id,
      title: "Noise complaint — upstairs neighbor after 11pm",
      status: "open",
      priority: "normal",
      category: "noise",
      source: "email",
      assignedTo: alice.id,
    },
  ];

  const insertedTickets = await db.insert(schema.tickets).values(ticketData).returning();
  console.log(`Created ${insertedTickets.length} tickets`);

  // Messages for tickets.
  // Tenants don't have user accounts in M1, so authorId is null for tenant messages;
  // authorRole distinguishes who wrote it.
  const messages = [
    // Ticket 0: leaking faucet
    { ticketId: insertedTickets[0].id, organizationId: org.id, authorId: null, authorRole: "tenant", body: "The kitchen faucet has been dripping constantly for two days. The drip is about once per second. I've tried tightening it but it doesn't help." },
    { ticketId: insertedTickets[0].id, organizationId: org.id, authorId: bob.id, authorRole: "staff", body: "Thanks Maria. I'll schedule a plumber visit for tomorrow morning between 9–11am. Please make sure someone is home." },
    { ticketId: insertedTickets[0].id, organizationId: org.id, authorId: null, authorRole: "agent", body: "Based on the lease agreement (Section 12.3), emergency plumbing repairs are the landlord's responsibility and must be addressed within 48 hours of being reported. This ticket qualifies. A plumber has been assigned." },

    // Ticket 1: heating
    { ticketId: insertedTickets[1].id, organizationId: org.id, authorId: null, authorRole: "tenant", body: "The heating has stopped working entirely. It's 13°C inside right now, which is dangerously cold for my infant. I need this resolved today." },
    { ticketId: insertedTickets[1].id, organizationId: org.id, authorId: carol.id, authorRole: "staff", body: "I've escalated this to our emergency maintenance line. An HVAC technician will arrive within 4 hours. We're very sorry for the inconvenience — we'll also arrange a space heater in the meantime." },

    // Ticket 2: door lock
    { ticketId: insertedTickets[2].id, organizationId: org.id, authorId: null, authorRole: "tenant", body: "The front door lock is really hard to turn — I sometimes have to jiggle the key for 30 seconds to get in. Worried it'll eventually stop working." },
    { ticketId: insertedTickets[2].id, organizationId: org.id, authorId: bob.id, authorRole: "staff", body: "Noted. We'll send maintenance to lubricate and inspect the lock next week. In the meantime, try using WD-40 on the keyhole if you have any." },

    // Ticket 6: mold
    { ticketId: insertedTickets[6].id, organizationId: org.id, authorId: null, authorRole: "tenant", body: "There's a dark spot about 30cm across on the bathroom ceiling, near the exhaust fan. I think it might be mold. I've attached a photo." },
    { ticketId: insertedTickets[6].id, organizationId: org.id, authorId: carol.id, authorRole: "staff", body: "Thank you for reporting this promptly. We'll send a specialist within 48 hours to assess whether it's mold and treat it if so. Please avoid disturbing the area." },
    { ticketId: insertedTickets[6].id, organizationId: org.id, authorId: null, authorRole: "agent", body: "This has been classified as a potential mold issue (category: mold, priority: urgent). Per the Hausordnung Section 8, tenants must report moisture issues promptly — they have complied. Landlord must inspect within 72 hours." },

    // Ticket 9: noise complaint
    { ticketId: insertedTickets[9].id, organizationId: org.id, authorId: null, authorRole: "tenant", body: "The tenant above me (2B) has been making loud noise after 11pm almost every night this week — TV blasting, heavy footsteps. I haven't been able to sleep." },
    { ticketId: insertedTickets[9].id, organizationId: org.id, authorId: alice.id, authorRole: "staff", body: "I'll send a courtesy notice to the tenant in 2B today reminding them of quiet hours per the house rules (10pm–8am on weekdays). If this continues please let us know." },
  ];

  await db.insert(schema.ticketMessages).values(messages);
  console.log(`Created ${messages.length} messages`);

  console.log("\nSeed complete.");
  console.log(`DEMO_ORG_ID=${org.id}`);
  console.log("Add this to .env.local if not already set.");
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
