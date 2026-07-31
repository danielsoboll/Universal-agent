import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  LOCAL_SESSION_COOKIE,
  SESSION_TTL_MS,
  signSessionPayload,
  verifySessionToken,
} from "@/lib/localAuth/sessionToken";
import { fileSessionRepository } from "@/lib/localAuth/sessionRepository";
import { fileUserRepository } from "@/lib/localAuth/userRepository";
import type { LocalRole, LocalSession, LocalUser } from "@/lib/localAuth/types";

export type LocalAuthContext = {
  session: LocalSession;
  user: LocalUser;
};

export async function readLocalSessionCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(LOCAL_SESSION_COOKIE)?.value ?? null;
}

export async function getLocalAuthContext(): Promise<LocalAuthContext | null> {
  const token = await readLocalSessionCookie();
  const payload = verifySessionToken(token);
  if (!payload) return null;
  const session = await fileSessionRepository.getById(payload.sid);
  if (!session || session.user_id !== payload.uid) return null;
  const user = await fileUserRepository.getById(session.user_id);
  if (!user || !user.enabled) return null;
  return { session, user };
}

export async function requireLocalUser(): Promise<LocalAuthContext> {
  const ctx = await getLocalAuthContext();
  if (!ctx) redirect("/login");
  return ctx;
}

export async function requireLocalAdmin(): Promise<LocalAuthContext> {
  const ctx = await requireLocalUser();
  if (ctx.user.role !== "admin") redirect("/app");
  return ctx;
}

export async function requireLocalAppAccess(): Promise<LocalAuthContext> {
  return requireLocalUser();
}

export async function setLocalSessionCookie(session: LocalSession) {
  const jar = await cookies();
  const token = signSessionPayload({
    sid: session.id,
    uid: session.user_id,
    role: session.role,
    exp: Date.parse(session.expires_at),
  });
  jar.set(LOCAL_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function clearLocalSessionCookie() {
  const jar = await cookies();
  jar.set(LOCAL_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export function primaryProjectId(user: LocalUser): string | null {
  return user.project_ids[0] ?? null;
}

export function roleHomePath(role: LocalRole): string {
  return role === "admin" ? "/admin" : "/app";
}
