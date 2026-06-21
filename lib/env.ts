import { config } from "dotenv";

// Load .env.local for non-Next processes (worker, tests, scripts). Next.js loads it
// automatically, so importing this there is a harmless no-op. Must be the FIRST import
// in any entrypoint that reads env at module load (e.g. the db client).
config({ path: ".env.local" });
