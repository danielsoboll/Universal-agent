import { NextResponse, type NextRequest } from "next/server";
import {
  LOCAL_SESSION_COOKIE,
  verifySessionTokenAsync,
} from "@/lib/localAuth/sessionToken";

/**
 * Local-session gate for today's E2E flow.
 * Supabase is not required. Role enforcement is also done in layouts.
 */
export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/auth/") ||
    pathname === "/forbidden";

  const token = request.cookies.get(LOCAL_SESSION_COOKIE)?.value;
  const session = await verifySessionTokenAsync(token);

  if (!session && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    if (pathname !== "/") {
      url.searchParams.set("next", pathname);
    }
    return NextResponse.redirect(url);
  }

  if (session && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = session.role === "admin" ? "/admin" : "/app";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (session?.role === "user" && pathname.startsWith("/admin")) {
    const url = request.nextUrl.clone();
    url.pathname = "/forbidden";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request });
}
