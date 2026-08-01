import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { CookieOptions } from "@supabase/ssr";
import { getSupabasePublicEnv } from "@/lib/supabase/env";

function safeNextPath(raw: string): string | null {
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return null;
}

type PendingCookie = {
  name: string;
  value: string;
  options: CookieOptions;
};

/** Origin, den der Browser wirklich nutzt (LAN-IP statt localhost). */
function publicOrigin(request: NextRequest): string {
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const host =
    forwardedHost ||
    request.headers.get("host") ||
    request.nextUrl.host;
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : request.nextUrl.protocol.replace(":", "") || "http";
  return `${proto}://${host}`;
}

function applyCookie(
  response: NextResponse,
  name: string,
  value: string,
  options: CookieOptions = {},
) {
  response.cookies.set(name, value, {
    path: options.path ?? "/",
    domain: options.domain,
    maxAge: options.maxAge,
    expires: options.expires,
    httpOnly: options.httpOnly,
    secure: options.secure,
    sameSite: options.sameSite as "lax" | "strict" | "none" | undefined,
  });
}

/** Alte/kaputte sb-*-auth-token(.N) Cookies entfernen. */
function clearAuthCookies(request: NextRequest, response: NextResponse) {
  for (const { name } of request.cookies.getAll()) {
    if (name.startsWith("sb-") && name.includes("auth-token")) {
      response.cookies.set(name, "", {
        path: "/",
        maxAge: 0,
      });
    }
  }
}

function redirectWithCookies(
  request: NextRequest,
  pathname: string,
  cookies: PendingCookie[],
  searchParams?: Record<string, string>,
) {
  const url = new URL(pathname, publicOrigin(request));
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) {
      url.searchParams.set(k, v);
    }
  }
  const response = NextResponse.redirect(url, { status: 303 });
  clearAuthCookies(request, response);
  for (const { name, value, options } of cookies) {
    applyCookie(response, name, value, options);
  }
  return response;
}

/**
 * Reliable login via Route Handler so Set-Cookie from signIn
 * is attached to the redirect response (Server Actions can drop them).
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const nextRaw = String(form.get("next") ?? "").trim();
  const next = safeNextPath(nextRaw);

  if (!email || !password) {
    return redirectWithCookies(request, "/login", [], {
      error: "E-Mail und Passwort sind erforderlich.",
      ...(next ? { next } : {}),
    });
  }

  const pendingCookies: PendingCookie[] = [];

  try {
    const { url, anonKey } = getSupabasePublicEnv();
    // Wichtig: bestehende Cookies ignorieren — kaputte Chunks (auth-token.0 etc.)
    // würden signIn/getUser sonst stören.
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return [];
        },
        setAll(cookiesToSet) {
          pendingCookies.length = 0;
          for (const c of cookiesToSet) {
            pendingCookies.push({
              name: c.name,
              value: c.value,
              options: c.options,
            });
          }
        },
      },
    });

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user || !data.session) {
      console.error("[auth/signin]", error?.message ?? "no user/session");
      return redirectWithCookies(request, "/login", [], {
        error:
          "Anmeldung fehlgeschlagen. E-Mail oder Passwort ungültig. Ein Konto kann hier nicht angelegt werden.",
        ...(next ? { next } : {}),
      });
    }

    let destination = next;
    if (!destination) {
      const { data: platform } = await supabase
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", data.user.id)
        .maybeSingle();
      const { data: profile } = await supabase
        .from("app_user_profiles")
        .select("role")
        .eq("user_id", data.user.id)
        .maybeSingle();

      if (
        platform ||
        profile?.role === "general_admin" ||
        profile?.role === "admin"
      ) {
        destination = "/admin/dashboard";
      } else {
        destination = "/app/ask";
      }
    }

    if (!pendingCookies.length) {
      await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
    }

    if (!pendingCookies.length) {
      console.error("[auth/signin] no session cookies after sign-in");
      return redirectWithCookies(request, "/login", [], {
        error:
          "Anmeldung technisch fehlgeschlagen (Session-Cookie). Bitte erneut versuchen.",
        ...(next ? { next } : {}),
      });
    }

    return redirectWithCookies(request, destination, pendingCookies);
  } catch (error) {
    console.error("[auth/signin]", error);
    return redirectWithCookies(request, "/login", [], {
      error: "Anmeldung technisch fehlgeschlagen. Bitte erneut versuchen.",
      ...(next ? { next } : {}),
    });
  }
}

/** GET auf /auth/signin → Login, kein 404. */
export async function GET(request: NextRequest) {
  return redirectWithCookies(request, "/login", []);
}
