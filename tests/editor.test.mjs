import assert from "node:assert/strict";
import test from "node:test";
import { prepareFamily } from "../src/editor.ts";
import { markedUp } from "../src/pricing.ts";

const at = "2026-02-01T00:00:00.000Z";
const photo = "/api/photos/" + "1".repeat(64);
const size = {
  id: "sample-small", variant: "Small", unit: "Box", overridePhoto: "",
  purchase: "", ready: true, rate: "10", history: [{ at: "2026-01-01", rate: "10" }],
};
const sample = {
  id: "sample-family", name: "Sample product", category: "Sample category", photo,
  gallery: [], collections: ["Sample collection"], variants: [size],
};

test("Preparing an edited family records only real selling-price changes", () => {
  const sameRate = prepareFamily({
    ...sample,
    name: " Sample product ",
    variants: [{ ...size, purchase: "6", rate: "10.00", variant: " Small " }],
  }, sample, at);
  assert.deepEqual(sameRate.family, {
    ...sample, variants: [{ ...size, purchase: "6.00" }],
  });

  const newRate = prepareFamily({
    ...sample, variants: [{ ...size, rate: "12.5" }],
  }, sample, at);
  assert.deepEqual(newRate.family.variants[0], {
    ...size, rate: "12.50", history: [...size.history, { at, rate: "12.50" }],
  });
  const cleared = prepareFamily({ ...sample, variants: [{ ...size, rate: "" }] }, sample, at);
  assert.deepEqual(cleared.family.variants[0].history, [...size.history, { at, rate: "" }]);
  assert.deepEqual(sample.variants[0].history, [{ at: "2026-01-01", rate: "10" }]);
});

test("Preparing an item reports which size has an invalid price, name or photo", () => {
  const second = { ...size, id: "sample-large", variant: "Large" };
  function prepare(patch, cover = photo) {
    return prepareFamily({ ...sample, photo: cover, variants: [
      { ...size, overridePhoto: photo }, { ...second, ...patch },
    ] }, undefined, at);
  }

  for (const [patch, cover, error] of [
    [{ purchase: "1.001" }, photo, /purchase price/],
    [{ rate: "0.00" }, photo, /positive rate/],
    [{ variant: " small " }, photo, /distinct name/],
    [{ variant: "" }, photo, /each size a name/],
    [{}, "", /photo for the verified size/],
  ]) {
    const result = prepare(patch, cover);
    assert.match(result.error, error);
    assert.equal(result.variantId, second.id);
  }
  assert.ok(prepare({ overridePhoto: photo }, "").family);
  assert.ok(prepare({ ready: false }, "").family);
});

test("Markup rounds to paise and rejects invalid or oversized selling prices", () => {
  assert.equal(markedUp("10.01", "50"), "15.02");
  assert.equal(markedUp("6", "0"), "6.00");
  assert.equal(markedUp("", "10"), "");
  assert.equal(markedUp("6", "-1"), "");
  assert.equal(markedUp("99999999.99", "10"), "");
});
