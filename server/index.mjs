import { handleProtectedAPI } from "./gateway.mjs";
import assets from "virtual:catalogue-assets";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) return handleProtectedAPI(request, env);
    const path = pathname === "/" || pathname === "/buyer" ? "/index.html" : pathname;
    const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
    if (!asset) return new Response("Page unavailable.", { status: 404 });
    return new Response(Uint8Array.from(atob(asset.data), (byte) => byte.charCodeAt(0)), {
      headers: {
        "Content-Type": asset.type,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-cache",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      },
    });
  },
};
