import type { ConnectionOptions } from "bullmq";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * BullMQ connection options derived from REDIS_URL. We pass options (not a shared
 * ioredis instance) so BullMQ builds its own clients with the settings it needs.
 * maxRetriesPerRequest: null is required for BullMQ's blocking commands.
 */
export function redisConnectionOptions(): ConnectionOptions {
  const u = new URL(REDIS_URL);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null,
  };
}
