import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UserProfile } from '@cardetect/shared';

interface StoredUser {
  salt: string;
  hash: string;
  avatar: string;
  createdAt: string;
  /** 断线重连令牌（每次登录/注册重新签发） */
  token?: string;
}

/** 极简账号存储：JSON 文件持久化，scrypt 加盐哈希密码。 */
export class UserStore {
  private users = new Map<string, StoredUser>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, StoredUser>;
        for (const [name, u] of Object.entries(raw)) this.users.set(name, u);
      } catch {
        console.warn(`[store] ${file} 损坏，已从空账号库重新开始`);
      }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.users), null, 2));
  }

  /** 注册。返回 null 表示成功，否则返回错误信息。 */
  register(username: string, password: string, avatar: string): string | null {
    if (!/^[\w一-龥-]{2,16}$/.test(username)) return '用户名需为 2~16 位中英文/数字/下划线';
    if (password.length < 4) return '密码至少 4 位';
    if (this.users.has(username)) return '用户名已被注册';
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    this.users.set(username, { salt, hash, avatar: avatar || 'avatar_1', createdAt: new Date().toISOString() });
    this.save();
    return null;
  }

  verify(username: string, password: string): UserProfile | null {
    const u = this.users.get(username);
    if (!u) return null;
    const hash = scryptSync(password, u.salt, 64);
    const expect = Buffer.from(u.hash, 'hex');
    if (hash.length !== expect.length || !timingSafeEqual(hash, expect)) return null;
    return { username, avatar: u.avatar };
  }

  get(username: string): UserProfile | null {
    const u = this.users.get(username);
    return u ? { username, avatar: u.avatar } : null;
  }

  /** 登录/注册成功后签发重连令牌（覆盖旧令牌并落盘） */
  setToken(username: string, token: string): void {
    const u = this.users.get(username);
    if (!u) return;
    u.token = token;
    this.save();
  }

  /** 按重连令牌找回用户（resume 用） */
  findByToken(token: string): UserProfile | null {
    if (!token) return null;
    for (const [username, u] of this.users) {
      if (u.token && u.token === token) return { username, avatar: u.avatar };
    }
    return null;
  }
}
