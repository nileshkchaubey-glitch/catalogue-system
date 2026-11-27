const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const uuid = (value) =>
  typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);

export function supabaseClient(env, fetchUpstream) {
  const url = new URL(env.SUPABASE_URL);
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (
    !loopback.has(url.hostname) || !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    typeof key !== "string" || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)
  ) throw Error("Invalid Supabase configuration");

  return (path, { token, headers, ...options } = {}) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("apikey", key);
    if (token) requestHeaders.set("Authorization", `Bearer ${token}`);
    return fetchUpstream(url.origin + path, {
      ...options,
      headers: requestHeaders,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
  };
}

export async function ownerProfile(supabase, token) {
  if (!token) return { status: 401 };
  const userResponse = await supabase("/auth/v1/user", { token });
  if ([401, 403].includes(userResponse.status)) return { status: 401 };
  if (!userResponse.ok) throw Error("Auth service unavailable");
  const user = await userResponse.json();
  if (!uuid(user.id) || user.is_anonymous !== false || user.role !== "authenticated")
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
  const row = rows[0];
  if (rows.length !== 1 || row?.owner_id !== user.id || !uuid(row.id))
    return { status: 403 };
  return {
    status: 200,
    ownerId: user.id,
    profile: { id: row.id, business_name: row.business_name, currency: row.currency },
  };
}

const workspacePath = "/rest/v1/catalogue_workspaces";
const photoDigest = /^catalog-studio\/photos\/([a-f0-9]{64})$/;

// Translate storage operations used by the schema 3 editor. The adapter has no R2 binding.
export function supabaseWorkspace(supabase, { ownerId }, token, valid) {
  const ownerFilter = `owner_id=eq.${ownerId}`;

  async function workspace() {
    const response = await supabase(`${workspacePath}?select=revision,document&${ownerFilter}&limit=2`, { token });
    if (!response.ok) throw Error("Workspace read failed");
    const rows = await response.json();
    if (rows.length === 0) return null;
    const { revision, document } = rows[0];
    if (rows.length !== 1 || !uuid(revision) || !valid(document))
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

      const previous = options.onlyIf.etagMatches;
      const revision = crypto.randomUUID();
      const record = { revision, document: JSON.parse(data) };
      const response = await supabase(
        previous ? `${workspacePath}?${ownerFilter}&revision=eq.${previous}` : workspacePath,
        {
          method: previous ? "PATCH" : "POST",
          token,
          headers: { "Content-Type": "application/json", Prefer: "return=representation" },
          body: JSON.stringify(previous ? record : { ...record, owner_id: ownerId }),
        },
      );
      if (!previous && response.status === 409) return null;
      if (!response.ok) throw Error("Workspace write failed");
      const rows = await response.json();
      if (previous && rows.length === 0) return null;
      if (rows.length !== 1 || rows[0].revision !== revision) throw Error("Workspace write not confirmed");
      return { etag: revision };
    },
  };
}
