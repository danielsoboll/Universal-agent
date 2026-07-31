import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabasePublicEnv } from "@/lib/supabase/env";

/**
 * Reliable logout via Route Handler so Set-Cookie from signOut
 * is attached to the redirect response (Server Actions can drop them).
 */
export async function POST(request: NextRequest) {
  let response = NextResponse.redirect(new URL("/login", request.url), {
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

  return response;
}

export async function GET(request: NextRequest) {
  return POST(request);
}
