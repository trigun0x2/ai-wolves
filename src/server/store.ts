import fs from "node:fs";
import path from "node:path";
import { createClient, type RedisClientType } from "redis";

/**
 * Tiny JSON key/value store behind an interface, so durable state (the
 * leaderboard) can live in Redis in production or a local file in dev with no
 * code change. Selected by environment:
 *   - REDIS_URL set  → Redis (e.g. Upstash on Fly.io)
 *   - otherwise       → JSON files under DATA_DIR (default ./data)
 *
 * NOTE: only non-secret state goes through here. The agent queue (which holds
 * contributors' API keys) is deliberately kept in process memory and never
 * written to any store.
 */
export interface KvStore {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown): Promise<void>;
  readonly kind: string;
}

class JsonFileStore implements KvStore {
  readonly kind = "json-file";
  constructor(private readonly dir: string) {}

  async getJson<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${key}.json`), "utf8")) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${key}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file); // atomic replace — no half-written file on crash
  }
}

class RedisStore implements KvStore {
  readonly kind = "redis";
  private readonly prefix = "aiwolves:";
  constructor(private readonly client: RedisClientType) {}

  async getJson<T>(key: string): Promise<T | null> {
    const v = await this.client.get(this.prefix + key);
    return v ? (JSON.parse(v) as T) : null;
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.client.set(this.prefix + key, JSON.stringify(value));
  }
}

/** Build the store from the environment, connecting to Redis if configured. */
export async function createStore(): Promise<KvStore> {
  const url = process.env.REDIS_URL;
  if (url) {
    const client: RedisClientType = createClient({ url });
    client.on("error", (err) => console.error("[redis] error:", err));
    await client.connect();
    console.log("[store] using Redis");
    return new RedisStore(client);
  }
  const dir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  console.log(`[store] using JSON files at ${dir}`);
  return new JsonFileStore(dir);
}
