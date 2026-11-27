import taxonomy from "../shared/taxonomy.json" with { type: "json" };
const KEY = "catalog-studio/preview-v1.json";
const FULL = "Full catalog";
const eligibleName = (s) =>
  typeof s === "string" &&
  s.length <= 100 &&
  [...s].every((c) => !/\p{L}/u.test(c) || /\p{Script=Latin}/u.test(c));
const name = (s) => eligibleName(s) && s.trim().length > 0;
const id = (s) => typeof s === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(s);
const rate = (s) =>
  s === "" ||
  (typeof s === "string" && /^\d{1,8}(\.\d{1,2})?$/.test(s) && Number(s) > 0);
const unique = (a) => new Set(a).size === a.length;
const urlPattern = /^\/api\/photos\/[0-9a-f]{64}$/;
const jpegPattern = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;
const photo = (s) =>
  typeof s === "string" &&
  (s === "" || urlPattern.test(s) || jpegPattern.test(s));
const error = (message, status) =>
  Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
function previous(doc) {
  if (doc.schema === 2) return doc;
  if (
    doc.schema != null ||
    !Array.isArray(doc.products) ||
    !Array.isArray(doc.customers)
  )
    throw Error("Unsupported workspace format");
  return {
    schema: 2,
    collections: Object.keys(taxonomy.legacyCollections),
    customers: doc.customers,
    families: doc.products.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      photo: p.photo,
      collections: Object.entries(taxonomy.legacyCollections)
        .filter(([, cats]) => cats.includes(p.category))
        .map(([g]) => g),
      variants: [
        {
          id: p.id,
          variant: p.variant,
          unit: p.unit,
          rate: p.rate,
          history: p.history,
          ready: p.ready,
          overridePhoto: "",
        },
      ],
    })),
  };
}
export function upgrade(doc) {
  if (doc.schema === 3) return doc;
  const legacy = previous(doc);
  return {
    ...legacy,
    schema: 3,
    departments: structuredClone(taxonomy.departments),
    families: legacy.families.map((family) => ({
      ...family,
      gallery: [],
      variants: family.variants.map((variant) => ({ ...variant, purchase: "" })),
    })),
  };
}
const safeName=s=>name(s)&&s===s.trim()&&!["__proto__","constructor","prototype"].includes(s.toLowerCase());
function valid(doc) {
  if (
    doc?.schema !== 3 ||
    !Array.isArray(doc.families) ||
    !Array.isArray(doc.collections) ||
    !Array.isArray(doc.customers)
  )
    return false;
  if(!doc.departments||typeof doc.departments!=="object"||Array.isArray(doc.departments))return false;
  const entries=Object.entries(doc.departments);if(!entries.length||!entries.every(([dept,cats])=>safeName(dept)&&Array.isArray(cats)&&cats.length&&cats.every(safeName)))return false;
  const categories=Object.values(doc.departments).flat();if(!unique(categories.map(c=>c.toLowerCase()))||!unique(Object.keys(doc.departments).map(c=>c.toLowerCase())))return false;
  const groups = doc.collections;
  if (
    !groups.every(
      (g) =>
        name(g) && g === g.trim() && g.toLowerCase() !== FULL.toLowerCase(),
    ) ||
    !unique(groups.map((g) => g.toLowerCase()))
  )
    return false;
  if (
    !doc.families.every(
      (f) =>
        f &&
        id(f.id) &&
        name(f.name) &&
        categories.includes(f.category) &&
        photo(f.photo) && Array.isArray(f.gallery) && f.gallery.every(pic=>pic&&photo(pic)) && unique(f.gallery) &&
        Array.isArray(f.collections) &&
        unique(f.collections) &&
        f.collections.every((g) => groups.includes(g)) &&
        Array.isArray(f.variants) &&
        f.variants.length > 0 &&
        f.variants.every(
          (v) =>
            v &&
            id(v.id) &&
            eligibleName(v.variant) &&
            (f.variants.length === 1 || v.variant.trim()) &&
            ["Piece", "Pack", "Box", "Carton", "Roll", "Set"].includes(
              v.unit,
            ) &&
            typeof v.ready === "boolean" &&
            photo(v.overridePhoto) &&
            (!v.ready || v.overridePhoto || f.photo) &&
            rate(v.rate) && rate(v.purchase) &&
            Array.isArray(v.history) &&
            v.history.every(
              (h) => h && Number.isFinite(Date.parse(h.at)) && rate(h.rate),
            ),
        ) &&
        unique(f.variants.map((v) => v.variant.trim().toLowerCase())),
    )
  )
    return false;
  return (
    unique(doc.families.map((f) => f.id)) &&
    unique(doc.families.flatMap((f) => f.variants.map((v) => v.id))) &&
    doc.customers.every(
      (c) =>
        c &&
        id(c.id) &&
        name(c.name) &&
        /^\d{8,15}$/.test(c.phone) &&
        (c.collection === FULL || groups.includes(c.collection)) &&
        typeof c.consent === "boolean",
    ) &&
    unique(doc.customers.map((c) => c.id)) &&
    unique(doc.customers.map((c) => c.phone))
  );
}
export function buyerProducts(doc, group) {
  return doc.families
    .filter((f) => group === FULL || f.collections.includes(group))
    .flatMap((f) =>
      f.variants
        .filter((v) => v.ready)
        .map((v) => ({
          id: v.id,
          familyId: f.id,
          name: f.name,
          category: f.category,
          variant: v.variant,
          unit: v.unit,
          photo: v.overridePhoto || f.photo,
          gallery: f.gallery,
        })),
    );
}
async function persistPhotos(doc, bucket) {
  const cached = new Map();
  async function store(value) {
    if (!value || urlPattern.test(value)) return value;
    if (cached.has(value)) return cached.get(value);
    const bytes = Uint8Array.from(
      atob(value.slice(value.indexOf(",") + 1)),
      (c) => c.charCodeAt(0),
    );
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    await bucket.put("catalog-studio/photos/" + digest, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "image/jpeg" },
    });
    const ref = "/api/photos/" + digest;
    cached.set(value, ref);
    return ref;
  }
  for (const family of doc.families) {
    family.photo = await store(family.photo);
    const gallery = await Promise.all(family.gallery.map(store));
    family.gallery = [...new Set(gallery.filter((picture) => picture !== family.photo))];
    for (const v of family.variants)
      v.overridePhoto = await store(v.overridePhoto);
  }
}
export async function handleAPI(request, bucket) {
  const url = new URL(request.url);
  if(url.pathname==="/api/photos"&&request.method==="POST"){
   if(request.headers.get("Origin")!==url.origin||request.headers.get("Content-Type")!=="image/jpeg")return error("Invalid photo request.",403);
   if(Number(request.headers.get("Content-Length"))>2*1024*1024)return error("Photo too large.",413);
   const bytes=new Uint8Array(await request.arrayBuffer());if(bytes.length>2*1024*1024||bytes[0]!==255||bytes[1]!==216)return error("Choose a JPEG photo.",422);
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),v=>v.toString(16).padStart(2,"0")).join("");
   await bucket.put("catalog-studio/photos/"+digest,bytes,{onlyIf:{etagDoesNotMatch:"*"},httpMetadata:{contentType:"image/jpeg"}});
   return Response.json({photo:"/api/photos/"+digest});
  }
  if (urlPattern.test(url.pathname) && request.method === "GET") {
    const asset = await bucket.get(
      "catalog-studio/photos/" + url.pathname.split("/").pop(),
    );
    return asset
      ? new Response(asset.body, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
          },
        })
      : error("Photo unavailable.", 404);
  }
  if (!["/api/workspace", "/api/buyer"].includes(url.pathname))
    return error("Page unavailable.", 404);
  if (request.method === "GET") {
    if(url.pathname==="/api/workspace" && request.headers.has("If-None-Match")){
      const current=await bucket.head(KEY);
      if(request.headers.get("If-None-Match")==='"'+(current?.etag||'new')+'"')return new Response(null,{status:304,headers:{'Cache-Control':'no-store'}});
    }
    const object = await bucket.get(KEY),
      doc = upgrade(
        object ? await object.json() : { products: [], customers: [] },
      );
    const group = url.searchParams.get("collection") || FULL;
    if (
      url.pathname === "/api/buyer" &&
      group !== FULL &&
      !doc.collections.includes(group)
    )
      return error("Unknown collection.", 404);
    return Response.json(
      url.pathname === "/api/buyer"
        ? { products: buyerProducts(doc, group) }
        : doc,
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Revision": object?.etag || "new",
        },
      },
    );
  }
  if (request.method !== "PUT" || url.pathname !== "/api/workspace")
    return error("Method unavailable.", 405);
  if (
    request.headers.get("Origin") !== url.origin ||
    !request.headers.get("Content-Type")?.startsWith("application/json")
  )
    return error("Request unavailable.", 403);
  const revision = request.headers.get("X-Revision");
  if (!revision) return error("Refresh before saving.", 428);
  const body = await request.text();
  if (new TextEncoder().encode(body).length > 12 * 1024 * 1024)
    return error("Save fewer new photos at once.", 413);
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return error("Invalid record.", 400);
  }
  if (doc?.schema !== 3)
    return error(
      "Refresh the app to open the updated catalog before saving.",
      409,
    );
  if (!valid(doc))
    return error(
      "Check product details, distinct size names, photos and collection selections.",
      422,
    );
  const metadata = await bucket.head(KEY);
  if ((metadata?.etag || "new") !== revision)
    return error("The workspace changed. Refresh before saving.", 409);
  await persistPhotos(doc, bucket);
  const result = await bucket.put(KEY, JSON.stringify(doc), {
    onlyIf:
      revision === "new"
        ? { etagDoesNotMatch: "*" }
        : { etagMatches: revision },
  });
  return result
    ? Response.json(
        { revision: result.etag, workspace: doc },
        { headers: { "Cache-Control": "no-store" } },
      )
    : error(
        "Another device saved changes. Reopen the form with the latest data.",
        409,
      );
}
