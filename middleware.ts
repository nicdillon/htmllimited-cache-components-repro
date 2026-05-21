import { NextResponse, type NextRequest } from "next/server";

const SEO_CRAWLERS =
  /Googlebot|AhrefsBot|SemrushBot|GPTBot|ClaudeBot|OAI-SearchBot|PerplexityBot|Bytespider/i;

export function middleware(req: NextRequest) {
  const ua = req.headers.get("user-agent") ?? "";
  if (SEO_CRAWLERS.test(ua)) {
    const headers = new Headers(req.headers);
    headers.set("x-original-user-agent", ua);
    headers.set("user-agent", "Twitterbot/1.0");
    return NextResponse.next({ request: { headers } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/item/:path*"],
};
