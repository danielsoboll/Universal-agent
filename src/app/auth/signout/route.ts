import { NextResponse, type NextRequest } from "next/server";
import { LOCAL_SESSION_COOKIE } from "@/lib/localAuth/sessionToken";

export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", request.url), {
    status: 303,
  });
  response.cookies.set(LOCAL_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest) {
  return POST(request);
}
