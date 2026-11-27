import { handleAPI, valid } from "./worker.mjs";
import { ownerProfile, supabaseClient, supabaseWorkspace } from "./supabase.mjs";

const access = "catalogue_access";
const refresh = "catalogue_refresh";
const cookieValue = /^[A-Za-z0-9._-]{1,4000}$/;

function cookie(request, name) {
  const value = request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value && cookieValue.test(value) ? value : undefined;
}

function sessionHeaders(url, session) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const attributes = `; Path=/; HttpOnly; SameSite=Lax${secure}`;
  const accessAge = session ? Math.min(Math.trunc(session.expires_in), 3600) : 0;
  headers.append("Set-Cookie", `${access}=${session?.access_token ?? ""}${attributes}; Max-Age=${accessAge}`);
  headers.append("Set-Cookie", `${refresh}=${session?.refresh_token ?? ""}${attributes}${session ? "" : "; Max-Age=0"}`);
  return headers;
}

function reply(message, status, headers = { "Cache-Control": "no-store" }) {
  return Response.json({ error: message }, { status, headers });
}

function rejected(result, headers) {
  return result.status === 403
    ? reply("This account has no provisioned owner profile.", 403, headers)
    : reply("Admin sign-in required.", 401, headers);
}

async function credentials(request) {
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json" || !request.body)
    return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 4096) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    const { email, password } = JSON.parse(text + decoder.decode());
    if (typeof email === "string" && email.trim().length <= 254 && email.includes("@") &&
        typeof password === "string" && password.length > 0 && password.length <= 1024)
      return { email: email.trim(), password };
  } catch {
    return null;
  }
  return null;
}

async function requestToken(supabase, grant, data) {
  const response = await supabase(`/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if ([400, 401, 403, 422, 429].includes(response.status)) return { status: response.status };
  if (!response.ok) throw Error("Auth service unavailable");
  const session = await response.json();
  if (typeof session.access_token !== "string" || !cookieValue.test(session.access_token) ||
      typeof session.refresh_token !== "string" || !cookieValue.test(session.refresh_token) ||
      !Number.isFinite(session.expires_in) || session.expires_in < 1)
    throw Error("Invalid auth response");
  return { status: 200, session };
}

async function handleSession(request, url, supabase) {
  const token = cookie(request, access);
  if (request.method === "DELETE") {
    const refreshToken = cookie(request, refresh);
    try {
      let sessionToken = token;
      if (!sessionToken && refreshToken)
        sessionToken = (await requestToken(supabase, "refresh_token", { refresh_token: refreshToken })).session?.access_token;
      if (sessionToken) {
        const response = await supabase("/auth/v1/logout?scope=local", { method: "POST", token: sessionToken });
        if (!response.ok && ![401, 403].includes(response.status))
          return reply("Signed out here. The session could not be revoked upstream.", 503, sessionHeaders(url));
      }
    } catch {
      return reply("Signed out here. The session could not be revoked upstream.", 503, sessionHeaders(url));
    }
    return new Response(null, { status: 204, headers: sessionHeaders(url) });
  }

  if (request.method === "POST") {
    const data = await credentials(request);
    if (!data) return reply("Enter your admin email and password.", 400);
    const { session, status } = await requestToken(supabase, "password", data);
    if (status === 429) return reply("Too many sign-in attempts. Try again shortly.", 429);
    if (!session) return reply("Email or password is incorrect.", 401);
    const result = await ownerProfile(supabase, session.access_token);
    return result.profile
      ? Response.json({ profile: result.profile }, { headers: sessionHeaders(url, session) })
      : rejected(result);
  }

  if (request.method !== "GET") return reply("Method unavailable.", 405);
  const result = await ownerProfile(supabase, token);
  if (result.profile)
    return Response.json({ profile: result.profile }, { headers: { "Cache-Control": "no-store" } });
  const refreshToken = cookie(request, refresh);
  if (result.status === 403 || !refreshToken) return rejected(result, sessionHeaders(url));
  const { session, status } = await requestToken(supabase, "refresh_token", { refresh_token: refreshToken });
  if (status === 429) return reply("Session refresh is rate limited. Try again shortly.", 429);
  if (!session) return rejected(result, sessionHeaders(url));
  const renewed = await ownerProfile(supabase, session.access_token);
  return renewed.profile
    ? Response.json({ profile: renewed.profile }, { headers: sessionHeaders(url, session) })
    : rejected(renewed, sessionHeaders(url));
}

export async function handleProtectedAPI(request, env, fetchUpstream = fetch) {
  const url = new URL(request.url);
  if (
    url.pathname !== "/api/session" && url.pathname !== "/api/workspace" &&
    url.pathname !== "/api/buyer" && url.pathname !== "/api/photos" &&
    !/^\/api\/photos\/[0-9a-f]{64}$/.test(url.pathname)
  ) return reply("Page unavailable.", 404);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    return reply("HTTPS required.", 403);
  if (request.method !== "GET" && request.headers.get("Origin") !== url.origin)
    return reply("Request unavailable.", 403);

  try {
    const supabase = supabaseClient(env, fetchUpstream);
    if (url.pathname === "/api/session") return await handleSession(request, url, supabase);
    const token = cookie(request, access);
    const result = await ownerProfile(supabase, token);
    if (!result.profile) return rejected(result);
    const expectedProfile = request.headers.get("X-Owner-Profile");
    if (expectedProfile && expectedProfile !== result.profile.id)
      return reply("The signed-in owner changed. Reload the workspace.", 403);
    const response = await handleAPI(request, supabaseWorkspace(supabase, result, token, valid));
    // Private images and owner data must not survive logout or an account switch in HTTP caches.
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    return reply("The workspace service is unavailable. Try again shortly.", 503);
  }
}
