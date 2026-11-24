import fs from 'node:fs/promises';
import path from 'node:path';
import { logLifecycle, logError } from './logging.js';
import { writeJsonFile } from './jsonFile.js';

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
    let parsed: unknown;
    let missing = false;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing = true;
      parsed = structuredClone(DEFAULT_FILE);
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.users)) {
      throw new Error('users.json must contain a users object');
    }
    const data: UsersFileShape = { users: { ...parsed.users } as Record<string, UserSettings> };
    let changed = missing;
    for (const name of FIXED_USERS) {
      if (!isPlainObject(data.users[name])) {
        data.users[name] = {};
        changed = true;
      }
    }
    if (changed) await writeJsonFile(this.filePath, data);
    this.data = data;
    logLifecycle('[USERS] Loaded', this.filePath);
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
    if (!FIXED_USERS.includes(name as UserName) || !isPlainObject(settings)) return null;
    const value = structuredClone(settings);
    const next = this.writing.then(async () => {
      const data = { users: { ...this.data.users, [name]: value } };
      await writeJsonFile(this.filePath, data);
      this.data = data;
    });
    this.writing = next.catch(err => {
      logError('[USERS] Failed to persist settings:', err?.message || err);
    });
    await next;
    return structuredClone(value);
  }

}

export function resolveUsersFilePath(rootDir: string): string {
  return path.resolve(rootDir, 'users.json');
}
