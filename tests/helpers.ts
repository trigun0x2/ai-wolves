import type { KvStore as IKvStore } from "../src/server/store";

/** In-memory KvStore for tests (stands in for Redis / the JSON file store). */
export class KvStore implements IKvStore {
  readonly kind = "memory";
  private data = new Map<string, string>();

  async getJson<T>(key: string): Promise<T | null> {
    const v = this.data.get(key);
    return v ? (JSON.parse(v) as T) : null;
  }

  async setJson(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }
}
