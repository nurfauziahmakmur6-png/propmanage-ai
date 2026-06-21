import { promises as fs } from "fs";
import path from "path";
import type { StorageProvider } from "./types";

// Files are stored on the local filesystem under ./storage. Swap this for an R2 or
// Cloudinary implementation later without changing callers.
export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly root = path.join(process.cwd(), "storage")) {}

  private resolve(key: string): string {
    const full = path.join(this.root, key);
    const rel = path.relative(this.root, full);
    // Reject keys that escape the storage root (path traversal).
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return full;
  }

  async save(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}
