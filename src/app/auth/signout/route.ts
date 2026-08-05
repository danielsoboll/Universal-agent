import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabasePublicEnv } from "@/lib/supabase/env";

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

/** Clear sb-*-auth-token cookies so /login is not bounced back to /. */
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

/**
 * Reliable logout via Route Handler so Set-Cookie from signOut
 * is attached to the redirect response (Server Actions can drop them).
 * Always ends on the email login screen.
 */
export async function POST(request: NextRequest) {
  let response = NextResponse.redirect(new URL("/login", publicOrigin(request)), {
    status: 303,
  });

  try {
    const { url, anonKey } = getSupabasePublicEnv();
    const supabase = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    });

    await supabase.auth.signOut({ scope: "local" });
  } catch (error) {
    console.error("[auth/signout]", error);
  }

  // Ensure session cookies are gone even if signOut omitted a chunk.
  clearAuthCookies(request, response);

  return response;
}

export async function GET(request: NextRequest) {
  return POST(request);
}
