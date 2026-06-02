import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";

/** Routes that require an authenticated session. */
const GATED_PREFIXES = ["/playground", "/keys"];

/** Auth routes — bounce a signed-in user away from these. */
const AUTH_PREFIXES = ["/login", "/signup"];

/**
 * Refreshes the Supabase session cookie on every matched request and gates
 * the protected app routes. Returns the response that must be returned from
 * Next.js `middleware` so the refreshed cookies are written back.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      }
    }
  });

  // IMPORTANT: getUser() revalidates the token with Supabase Auth and refreshes
  // the cookie. Do not run any logic between createServerClient and getUser().
  const {
    data: { user }
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isGated = GATED_PREFIXES.some((p) => pathname.startsWith(p));
  const isAuthRoute = AUTH_PREFIXES.some((p) => pathname.startsWith(p));

  if (!user && isGated) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/playground";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
