import test from "node:test";
import assert from "node:assert/strict";
import { handleAPI } from "../server/worker.mjs";
import { prepareFamily } from "../src/editor.ts";
import taxonomy from "../shared/taxonomy.json" with { type: "json" };
class TestBucket {
  objects = new Map();
  async head(k) {
    return this.objects.get(k);
  }
  async get(k) {
    return this.objects.get(k);
  }
  async put(k, data, { onlyIf }) {
    const old = this.objects.get(k);
    if (
      onlyIf.etagDoesNotMatch === "*" ? old : onlyIf.etagMatches !== old?.etag
    )
      return null;
    const value = {
      etag: crypto.randomUUID(),
      body: data,
      json: async () => JSON.parse(data),
    };
    this.objects.set(k, value);
    return value;
  }
}
const bucketKey = "catalog-studio/preview-v1.json";
const image = "data:image/jpeg;base64,MTIz";
const detailImage = "data:image/jpeg;base64,NDU2";
const draftImage = "data:image/jpeg;base64,Nzg5";
const history = [{ at: "2026-01-01", rate: "10" }];

function workspaceFixture() {
  const bucket = new TestBucket();
  const origin = "https://catalog.test";
  const call = (path, options) =>
    handleAPI(new Request(origin + path, options), bucket);
  const put = (doc, rev) =>
    call("/api/workspace", {
      method: "PUT",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Revision": rev,
      },
      body: JSON.stringify(doc),
    });
  const seed = (doc) => bucket.put(bucketKey, JSON.stringify(doc), {
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return { bucket, call, put, seed };
}

test("Upgrade, shared photos, overlapping collections, buyer privacy and conflicting saves", async () => {
  const { bucket, call, put, seed } = workspaceFixture();
  const customer = {
    id: "c",
    phone: "0000000000",
    consent: true,
    name: "Test contact",
    collection: "Restaurant & Takeaway",
  };
  const p = {
    id: "old",
    name: "Test product",
    category: "Silver foil containers",
    photo: image,
    variant: "250 ml",
    rate: "10.00",
    history: [{ at: "2026-01-01", rate: "10.00" }],
    unit: "Pack",
    ready: true,
  };
  const old = { products: [p], customers: [customer] };
  await seed(old);
  let res = await call("/api/workspace"),
    rev = res.headers.get("X-Revision"),
    doc = await res.json();
  assert.deepEqual(await (await bucket.get(bucketKey)).json(), old);
  assert.equal(doc.schema, 3);
  assert.deepEqual(doc.customers, [customer]);
  const family = doc.families[0];
  assert.deepEqual(family.variants[0].history, p.history);
  family.variants[0].purchase = "5.25";
  assert.deepEqual(family.collections, [
    "Restaurant & Takeaway",
    "Catering & Events",
  ]);
  for (const [i, size] of ["450 ml", "600 ml", "750 ml"].entries())
    family.variants.push({
      ...family.variants[0],
      id: "v" + i,
      variant: size,
      overridePhoto: i === 2 ? "data:image/jpeg;base64,NDU2" : "",
    });
  family.variants.push({
    ...family.variants[0],
    id: "draft",
    variant: "Test draft",
    ready: false,
  });
  doc.collections.push("Custom collection");
  family.collections.push("Custom collection");
  res = await put(doc, rev);
  assert.equal(res.status, 200);
  const saved = await res.json();
  doc = saved.workspace;
  assert.equal(bucket.objects.size, 3);
  assert.match(doc.families[0].photo, /^\/api\/photos\/[0-9a-f]{64}$/);
  assert.equal((await put(old, rev)).status, 409);
  assert.equal((await put(doc, rev)).status, 409);
  const buyer = async (group) =>
    (
      await (
        await call("/api/buyer?collection=" + encodeURIComponent(group))
      ).json()
    ).products;
  const rows = await buyer("Custom collection");
  assert.equal(rows.length, 4);
  assert.equal(rows[0].photo, rows[2].photo);
  assert.notEqual(rows[2].photo, rows[3].photo);
  assert.deepEqual(rows, await buyer("Restaurant & Takeaway"));
  assert.deepEqual(rows, await buyer("Catering & Events"));
  assert.deepEqual([], await buyer("Tea & Café"));
  assert.equal(await (await call(rows[3].photo)).text(), "456");
  assert.deepEqual(
    Object.keys(rows[0]).sort(),
    ["id", "familyId", "name", "category", "variant", "unit", "photo", "gallery"].sort(),
  );
  doc.families[0].photo = "data:image/jpeg;base64,Nzg5";
  doc.families[0].collections = doc.families[0].collections.filter(
    (g) => g !== "Restaurant & Takeaway",
  );
  res = await put(doc, saved.revision);
  assert.equal(res.status, 200);
  const changed = await res.json();
  assert.deepEqual([], await buyer("Restaurant & Takeaway"));
  const after = await buyer("Custom collection");
  assert.notEqual(rows[0].photo, after[0].photo);
  assert.equal(after[0].photo, after[2].photo);
  assert.equal(after[3].photo, rows[3].photo);
  changed.workspace.families[0].variants[3].overridePhoto = "";
  assert.equal((await put(changed.workspace, changed.revision)).status, 200);
  assert.equal((await buyer("Custom collection"))[3].photo, after[0].photo);
});

test("Schema 2 migration preserves records and persists one schema 3 editor save", async () => {
  const { bucket, call, put, seed } = workspaceFixture();
  const variant = {
    id: "sample-small", variant: "Small", unit: "Piece", overridePhoto: "",
    ready: true, rate: "10", history,
  };
  const legacy = {
    schema: 2,
    collections: ["Sample collection"],
    customers: [
      { id: "sample-customer", name: "Sample contact", phone: "0000000001", collection: "Sample collection", consent: true },
      { id: "sample-customer-2", name: "Sample contact two", phone: "0000000002", collection: "Full catalog", consent: false },
    ],
    families: [
      {
        id: "sample-family", name: "Sample product", category: "Plastic containers", photo: image,
        collections: ["Sample collection"],
        variants: [
          variant,
          { ...variant, id: "sample-large", variant: "Large", overridePhoto: draftImage, ready: false },
        ],
      },
      {
        id: "another-family", name: "Another sample", category: "Tape rolls", photo: "",
        collections: [], variants: [{ ...variant, id: "sample-other", variant: "", ready: false }],
      },
    ],
  };
  const original = await seed(legacy);
  const read = await call("/api/workspace");
  assert.equal(read.headers.get("X-Revision"), original.etag);
  const migrated = await read.json();
  assert.deepEqual(migrated, {
    ...legacy,
    schema: 3,
    departments: taxonomy.departments,
    families: legacy.families.map((family) => ({
      ...family,
      gallery: [],
      variants: family.variants.map((item) => ({ ...item, purchase: "" })),
    })),
  });
  assert.deepEqual(await (await bucket.get(bucketKey)).json(), legacy);
  assert.equal((await put(legacy, original.etag)).status, 409);

  const family = migrated.families[0];
  const draft = {
    ...family,
    category: "Sample category",
    collections: [...family.collections, "New sample collection"],
    gallery: [detailImage, image],
    variants: [{ ...family.variants[0], purchase: "6.1" }, family.variants[1]],
  };
  const prepared = prepareFamily(draft, family, "2026-02-01T00:00:00.000Z");
  assert.ok(prepared.family);
  const updated = {
    ...migrated,
    departments: { ...migrated.departments, "Sample department": [draft.category] },
    collections: [...migrated.collections, "New sample collection"],
    families: [prepared.family, migrated.families[1]],
  };
  assert.equal((await put({ ...updated, departments: migrated.departments }, original.etag)).status, 422);
  assert.deepEqual(await (await bucket.get(bucketKey)).json(), legacy);
  const response = await put(updated, original.etag);
  assert.equal(response.status, 200);
  const { workspace, revision } = await response.json();
  assert.deepEqual(await (await bucket.get(bucketKey)).json(), workspace);
  assert.notEqual(revision, original.etag);
  assert.equal((await put(updated, original.etag)).status, 409);
  assert.deepEqual(workspace.customers, legacy.customers);
  assert.deepEqual(workspace.departments, updated.departments);
  assert.deepEqual(workspace.collections, updated.collections);
  assert.deepEqual(workspace.families[1], migrated.families[1]);
  const saved = workspace.families[0];
  assert.equal(saved.id, family.id);
  assert.deepEqual(saved.variants[0], { ...family.variants[0], purchase: "6.10" });
  const { overridePhoto } = saved.variants[1];
  assert.deepEqual(saved.variants[1], { ...family.variants[1], overridePhoto });
  assert.equal(await (await call(overridePhoto)).text(), "789");
  assert.equal(saved.gallery.length, 1);
  assert.equal(await (await call(saved.gallery[0])).text(), "456");
  assert.equal(await (await call(saved.photo)).text(), "123");

  const buyer = await call("/api/buyer?collection=New%20sample%20collection");
  assert.deepEqual(await buyer.json(), { products: [{
    id: variant.id, familyId: family.id, name: family.name, category: draft.category,
    variant: variant.variant, unit: variant.unit, photo: saved.photo, gallery: saved.gallery,
  }] });
});
