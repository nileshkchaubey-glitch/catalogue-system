import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { access } from "node:fs/promises";
import taxonomy from "../../shared/taxonomy.json" with { type: "json" };

const password = "browser-test-password";
const publishableKey = "sb_publishable_catalogue_browser_fixture";
export const owners = {
  desktop: {
    id: "a0000000-0000-4000-8000-000000000001",
    email: "desktop-owner@example.invalid",
    password,
  },
  mobile: {
    id: "a0000000-0000-4000-8000-000000000002",
    email: "mobile-owner@example.invalid",
    password,
  },
  unprovisioned: {
    id: "a0000000-0000-4000-8000-000000000003",
    email: "unprovisioned@example.invalid",
    password,
  },
};
export const photo = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AaP/Z",
  "base64",
);
const digest = createHash("sha256").update(photo).digest("hex");
export const photoRoute = "/api/photos/" + digest;

function workspace(owner) {
  return {
    schema: 3,
    departments: taxonomy.departments,
    collections: Object.keys(taxonomy.legacyCollections),
    customers: [],
    families: [{
      id: owner === owners.desktop.id ? "test-family-desktop" : "test-family-mobile",
      name: owner === owners.desktop.id ? "Desktop fixture tray" : "Mobile fixture tray",
      category: "Silver foil containers",
      photo: photoRoute,
      gallery: [],
      collections: ["Restaurant & Takeaway"],
      variants: [{
        id: owner === owners.desktop.id ? "test-variant-desktop" : "test-variant-mobile",
        variant: "250 ml",
        unit: "Pack",
        overridePhoto: "",
        ready: true,
        purchase: "5.00",
        rate: "10.00",
        history: [{ at: "2026-01-01", rate: "10.00" }],
      }],
    }],
  };
}

async function serve(handle) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers(incoming.headers);
      const init = { method: incoming.method, headers };
      if (!["GET", "HEAD"].includes(incoming.method)) {
        init.body = Readable.toWeb(incoming);
        init.duplex = "half";
      }
      const url = new URL(incoming.url, "http://127.0.0.1:" + server.address().port);
      const response = await handle(new Request(url, init), url);
      for (const [name, value] of response.headers) {
        if (name !== "set-cookie") outgoing.setHeader(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("Set-Cookie", cookies);
      outgoing.writeHead(response.status);
      outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
    } catch (error) {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function fakeSupabase(writeKey, logoutDelayMs = 0) {
  const audit = [];
  const profiles = new Map([
    [owners.desktop.id, {
      id: "b0000000-0000-4000-8000-000000000001",
      owner_id: owners.desktop.id,
      business_name: "Desktop Fixture Studio",
      currency: "INR",
    }],
    [owners.mobile.id, {
      id: "b0000000-0000-4000-8000-000000000002",
      owner_id: owners.mobile.id,
      business_name: "Mobile Fixture Studio",
      currency: "INR",
    }],
  ]);
  const rows = new Map([
    [owners.desktop.id, { owner_id: owners.desktop.id, revision: randomUUID(), document: workspace(owners.desktop.id) }],
  ]);
  const media = new Map([[owners.desktop.id + "/" + digest + ".jpg", photo]]);
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const unauthenticated = () => Response.json({ message: "Invalid fixture session" }, { status: 401 });
  const denied = () => Response.json({ code: "42501" }, { status: 403 });

  function issue(session) {
    const { owner } = session;
    const access = "fixture-access-" + randomUUID();
    const refresh = "fixture-refresh-" + randomUUID();
    accessTokens.set(access, session);
    refreshTokens.set(refresh, session);
    return Response.json({
      access_token: access,
      refresh_token: refresh,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: owner.id, email: owner.email, is_anonymous: false, role: "authenticated" },
    });
  }

  async function handle(request, url) {
    assert.equal(request.headers.get("apikey"), publishableKey);
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const session = accessTokens.get(token);
    const actor = session?.owner;
    const { pathname, searchParams } = url;
    const { method } = request;
    audit.push({ actor: actor?.id, method, pathname, ownerFilter: searchParams.get("owner_id") });
    const capability = request.headers.get("X-Catalogue-Workspace-Write-Key");
    if (pathname !== "/rest/v1/rpc/save_catalogue_workspace") assert.equal(capability, null);
    if (pathname === "/auth/v1/token" && method === "POST") {
      const body = await request.json();
      if (searchParams.get("grant_type") === "refresh_token") {
        const renewed = refreshTokens.get(body.refresh_token);
        if (!renewed?.active) return unauthenticated();
        refreshTokens.delete(body.refresh_token);
        return issue(renewed);
      }
      if (searchParams.get("grant_type") !== "password") return unauthenticated();
      const owner = Object.values(owners).find((item) => item.email === body.email && item.password === body.password);
      return owner ? issue({ owner, active: true }) : unauthenticated();
    }
    if (!actor) return unauthenticated();
    if (pathname === "/auth/v1/user" && method === "GET")
      return Response.json({ id: actor.id, email: actor.email, is_anonymous: false, role: "authenticated" });
    if (pathname === "/auth/v1/logout" && method === "POST") {
      if (!session.active) return unauthenticated();
      if (logoutDelayMs) await new Promise(resolve => setTimeout(resolve, logoutDelayMs));
      session.active = false;
      return new Response(null, { status: 204 });
    }

    const ownFilter = searchParams.get("owner_id") === "eq." + actor.id;
    if (pathname === "/rest/v1/business_profiles" && method === "GET") {
      if (!ownFilter) return denied();
      const profile = profiles.get(actor.id);
      return Response.json(session.active && profile ? [profile] : []);
    }
    if (!session.active || !profiles.has(actor.id)) return denied();
    if (pathname === "/rest/v1/catalogue_workspaces") {
      if (method !== "GET" || !ownFilter) return denied();
      const row = rows.get(actor.id);
      return Response.json(row ? [row] : []);
    }
    if (pathname === "/rest/v1/rpc/save_catalogue_workspace") {
      if (method !== "POST" || capability !== writeKey) return denied();
      const body = await request.json();
      assert.deepEqual(Object.keys(body).sort(), ["expected_revision", "workspace_document"]);
      if (!session.active) return denied();
      const current = rows.get(actor.id);
      if (body.expected_revision !== (current?.revision ?? null)) return Response.json(null);
      const revision = randomUUID();
      rows.set(actor.id, { revision, document: body.workspace_document, owner_id: actor.id });
      return Response.json(revision);
    }

    const match = /^\/storage\/v1\/object\/(authenticated\/)?catalogue-media\/([^/]+)\/([0-9a-f]{64}\.jpg)$/.exec(pathname);
    if (match) {
      const [, privateRead, folder, filename] = match;
      if (folder !== actor.id) return denied();
      const key = folder + "/" + filename;
      if (method === "GET" && privateRead) {
        const bytes = media.get(key);
        return bytes ? new Response(bytes, { headers: { "Content-Type": "image/jpeg" } }) :
          Response.json({ statusCode: "404" }, { status: 404 });
      }
      if (method === "POST" && !privateRead && request.headers.get("x-upsert") === "false") {
        if (media.has(key)) return Response.json({ statusCode: "409" }, { status: 409 });
        media.set(key, Buffer.from(await request.arrayBuffer()));
        return Response.json({ Key: key });
      }
    }
    return new Response("Unexpected fixture route", { status: 404 });
  }
  return { handle, audit, rows };
}

export async function createLocalFixture(t, { logoutDelayMs = 0 } = {}) {
  const bundle = new URL("../../dist/server/index.js", import.meta.url);
  await access(bundle).catch(() => { throw Error("Run npm run build before the browser suite."); });
  const { default: worker } = await import(bundle.href);
  const writeKey = randomBytes(32).toString("hex");
  const supabase = fakeSupabase(writeKey, logoutDelayMs);
  const upstream = await serve(supabase.handle);
  t.after(() => upstream.close());
  const app = await serve((request) => worker.fetch(request, {
    SUPABASE_URL: upstream.origin,
    SUPABASE_PUBLISHABLE_KEY: publishableKey,
    CATALOGUE_WORKSPACE_WRITE_KEY: writeKey,
  }));
  t.after(() => app.close());
  return {
    ...app,
    rows: supabase.rows,
    audit: supabase.audit,
    async request(path, options = {}) {
      return fetch(app.origin + path, { redirect: "manual", ...options });
    },
  };
}
