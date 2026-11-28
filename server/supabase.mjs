const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const uuid = (value) =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export const validWorkspaceWriteKey = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function supabaseClient(env, fetchUpstream) {
  const url = new URL(env.SUPABASE_URL);
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  // Both values are trusted Worker bindings, never derived from browser input.
  // The release operator records the approved origin independently of the URL.
  const approved = env.CATALOGUE_APPROVED_SUPABASE_ORIGIN;
  const originAllowed = approved === undefined
    ? loopback.has(url.hostname) && ["http:", "https:"].includes(url.protocol)
    : typeof approved === "string" &&
      /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(approved) &&
      url.origin === approved;
  if (
    !originAllowed ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    typeof key !== "string" || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)
  ) throw Error("Invalid Supabase configuration");

  return async (path, { token, headers, ...options } = {}) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("apikey", key);
    if (token) requestHeaders.set("Authorization", `Bearer ${token}`);
    const response = await fetchUpstream(url.origin + path, {
      ...options,
      headers: requestHeaders,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw Error("Unexpected Supabase redirect");
    }
    return response;
  };
}

export async function ownerProfile(supabase, token) {
  if (!token) return { status: 401 };
  const userResponse = await supabase("/auth/v1/user", { token });
  if ([401, 403].includes(userResponse.status)) return { status: 401 };
  if (!userResponse.ok) throw Error("Auth service unavailable");
  const user = await userResponse.json();
  if (!uuid(user?.id) || user.is_anonymous !== false || user.role !== "authenticated")
    return { status: 403 };

  const query = new URLSearchParams({
    owner_id: `eq.${user.id}`,
    select: "id,owner_id,business_name,currency",
    limit: "2",
  });
  const response = await supabase(`/rest/v1/business_profiles?${query}`, { token });
  if ([401, 403].includes(response.status)) return { status: response.status };
  if (!response.ok) throw Error("Profile service unavailable");
  const rows = await response.json();
  if (!Array.isArray(rows)) throw Error("Invalid profile response");
  const row = rows[0];
  if (rows.length !== 1 || row?.owner_id !== user.id || !uuid(row.id) ||
      typeof row.business_name !== "string" || typeof row.currency !== "string")
    return { status: 403 };
  return {
    status: 200,
    ownerId: user.id,
    profile: { id: row.id, business_name: row.business_name, currency: row.currency },
  };
}

const workspacePath = "/rest/v1/catalogue_workspaces";
const saveWorkspacePath = "/rest/v1/rpc/save_catalogue_workspace";
const photoDigest = /^catalog-studio\/photos\/([a-f0-9]{64})$/;

// Translate storage operations used by the schema 3 editor. The adapter has no R2 binding.
export function supabaseWorkspace(supabase, { ownerId }, token, valid, workspaceWriteKey) {
  const ownerFilter = `owner_id=eq.${ownerId}`;

  async function workspace() {
    const response = await supabase(`${workspacePath}?select=owner_id,revision,document&${ownerFilter}&limit=2`, { token });
    if (!response.ok) throw Error("Workspace read failed");
    const rows = await response.json();
    if (!Array.isArray(rows)) throw Error("Unexpected workspace record");
    if (rows.length === 0) return null;
    const { owner_id, revision, document } = rows[0] ?? {};
    if (rows.length !== 1 || owner_id !== ownerId || !uuid(revision) || !valid(document))
      throw Error("Unexpected workspace record");
    return { etag: revision, json: async () => document };
  }

  async function getPhoto(digest) {
    const response = await supabase(`/storage/v1/object/authenticated/catalogue-media/${ownerId}/${digest}.jpg`, { token });
    if (response.status === 404) return null;
    if (response.status === 400) {
      const details = await response.json().catch(() => null);
      if (String(details?.statusCode) === "404") return null;
    }
    if (!response.ok) throw Error("Photo read failed");
    if (response.headers.get("Content-Type")?.split(";")[0] !== "image/jpeg") {
      await response.body?.cancel();
      return null;
    }
    return { body: response.body };
  }

  return {
    head: workspace,
    async get(key) {
      const photo = photoDigest.exec(key);
      return photo ? getPhoto(photo[1]) : workspace();
    },
    async put(key, data, options) {
      const photo = photoDigest.exec(key);
      if (photo) {
        const response = await supabase(`/storage/v1/object/catalogue-media/${ownerId}/${photo[1]}.jpg`, {
          method: "POST",
          token,
          headers: { "Content-Type": "image/jpeg", "x-upsert": "false" },
          body: data,
        });
        if (response.ok) return;
        if (response.status === 409 || response.status === 400) {
          const existing = await getPhoto(photo[1]);
          if (existing) {
            await existing.body?.cancel();
            return;
          }
        }
        throw Error("Photo upload failed");
      }

      const expected = options?.onlyIf?.etagMatches;
      if (!validWorkspaceWriteKey(workspaceWriteKey) ||
          (expected === undefined ? options?.onlyIf?.etagDoesNotMatch !== "*" : !uuid(expected)))
        throw Error("Invalid workspace write configuration");
      const response = await supabase(saveWorkspacePath, {
        method: "POST",
        token,
        headers: {
          "Content-Type": "application/json",
          "X-Catalogue-Workspace-Write-Key": workspaceWriteKey,
        },
        body: JSON.stringify({ expected_revision: expected ?? null, workspace_document: JSON.parse(data) }),
      });
      if (!response.ok) throw Error("Workspace write failed");
      const revision = await response.json();
      if (revision === null) return null;
      if (!uuid(revision) || revision === expected) throw Error("Workspace write not confirmed");
      return { etag: revision };
    },
  };
}
