import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { getLocalDataRoot } from "@/lib/localData/root";

const BCRYPT_ROUNDS = 10;

export function appConfigDir(): string {
  const root = getLocalDataRoot();
  const dir = path.join(root, "app-config");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function appConfigPath(...segments: string[]): string {
  return path.join(appConfigDir(), ...segments);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Ensure LOCAL_SESSION_SECRET exists in app-config for operators (not auto-logged). */
export function ensureSessionSecretFile(): string {
  const secretFile = appConfigPath("session_secret.txt");
  if (existsSync(secretFile)) {
    return readFileSync(secretFile, "utf8").trim();
  }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
  return secret;
}
