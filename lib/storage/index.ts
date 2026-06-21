import type { StorageProvider } from "./types";
import { LocalStorageProvider } from "./local";

export type { StorageProvider } from "./types";

let cached: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (cached) return cached;
  const choice = process.env.STORAGE_PROVIDER ?? "local";
  switch (choice) {
    case "local":
      cached = new LocalStorageProvider();
      return cached;
    default:
      throw new Error(`Unknown STORAGE_PROVIDER: ${choice}`);
  }
}

export function documentStorageKey(organizationId: string, documentId: string): string {
  return `${organizationId}/${documentId}.pdf`;
}
