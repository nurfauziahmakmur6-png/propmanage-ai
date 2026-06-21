export interface StorageProvider {
  // key is an opaque path like "<orgId>/<docId>.pdf"
  save(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
