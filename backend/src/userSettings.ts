import fs from 'node:fs/promises';
import path from 'node:path';
import { logLifecycle, logError, GRN, YEL, RED, RST } from './logging.js';

export const FIXED_USERS = ['Default User', 'Jan', 'Dennis'] as const;
export type UserName = typeof FIXED_USERS[number];

export interface UserSettings {
  // Open-ended bag — frontend writes whatever shape it wants.
  // Today: { detailZoomSec: number }. Add fields freely.
  [key: string]: unknown;
}

export interface UsersFileShape {
  users: Record<string, UserSettings>;
}

const DEFAULT_FILE: UsersFileShape = {
  users: {
    'Default User': {},
    Jan: {},
    Dennis: {},
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export class UserSettingsStore {
  private filePath: string;
  private data: UsersFileShape = { users: {} };
  private writing: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed) && isPlainObject((parsed as any).users)) {
        this.data = { users: { ...(parsed as any).users } };
        logLifecycle(`${GRN}[USERS] Loaded ${this.filePath}${RST}`);
      } else {
        logLifecycle(`${YEL}[USERS] ${this.filePath} malformed; resetting to defaults.${RST}`);
        this.data = structuredClone(DEFAULT_FILE);
        await this.persist();
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        logLifecycle(`${YEL}[USERS] ${this.filePath} not found, creating with defaults.${RST}`);
      } else {
        logError(`${RED}[USERS] Failed to read ${this.filePath}, resetting:${RST}`, err?.message || err);
      }
      this.data = structuredClone(DEFAULT_FILE);
      await this.persist();
    }

    // Ensure all fixed users exist in the file even if it was previously written without one.
    let mutated = false;
    for (const name of FIXED_USERS) {
      if (!isPlainObject(this.data.users[name])) {
        this.data.users[name] = {};
        mutated = true;
      }
    }
    if (mutated) await this.persist();
  }

  list(): Array<{ name: string; settings: UserSettings }> {
    return FIXED_USERS.map((name) => ({
      name,
      settings: { ...(this.data.users[name] ?? {}) },
    }));
  }

  get(name: string): UserSettings | null {
    if (!FIXED_USERS.includes(name as UserName)) return null;
    return { ...(this.data.users[name] ?? {}) };
  }

  async setSettings(name: string, settings: UserSettings): Promise<UserSettings | null> {
    if (!FIXED_USERS.includes(name as UserName)) return null;
    if (!isPlainObject(settings)) return null;
    this.data.users[name] = { ...settings };
    await this.persist();
    return { ...this.data.users[name] };
  }

  private async persist(): Promise<void> {
    // Serialize writes so concurrent PUTs can't interleave.
    const next = this.writing.then(async () => {
      const tmp = `${this.filePath}.tmp`;
      const text = JSON.stringify(this.data, null, 2) + '\n';
      await fs.writeFile(tmp, text, 'utf8');
      await fs.rename(tmp, this.filePath);
    });
    this.writing = next.catch((err) => {
      logError(`${RED}[USERS] Failed to write ${this.filePath}:${RST}`, err?.message || err);
    });
    return this.writing;
  }
}

export function resolveUsersFilePath(rootDir: string): string {
  return path.resolve(rootDir, 'users.json');
}
