import test from "node:test";
import assert from "node:assert/strict";
import { handleAPI } from "../server/worker.mjs";
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
test("Upgrade, shared photos, overlapping collections, buyer privacy and conflicting saves", async () => {
  const bucket = new TestBucket(),
    origin = "https://catalog.test";
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
  const customer = {
    id: "c",
    phone: "0000000000",
    consent: true,
    name: "Test contact",
    collection: "Restaurant & Takeaway",
  };
  const image = "data:image/jpeg;base64,MTIz";
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
  const bucketKey = "catalog-studio/preview-v1.json";
  await bucket.put(bucketKey, JSON.stringify(old), {
    onlyIf: { etagDoesNotMatch: "*" },
  });
  let res = await call("/api/workspace"),
    rev = res.headers.get("X-Revision"),
    doc = await res.json();
  assert.deepEqual(await (await bucket.get(bucketKey)).json(), old);
  assert.deepEqual(doc.customers, [customer]);
  const family = doc.families[0];
  assert.deepEqual(family.variants[0].history, p.history);
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
    ["id", "familyId", "name", "category", "variant", "unit", "photo"].sort(),
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
