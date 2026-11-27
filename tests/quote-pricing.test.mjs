import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBulkMarkup,
  buildBulkPreview,
  buildQuoteSnapshot,
  markedUp,
  quotableProducts,
  quoteRecipientAllowed,
  quoteText,
  validQuoteTransition,
  validQuoteWorkspace,
} from "../shared/quote-pricing.mjs";

const at = "2026-02-01T00:00:00.000Z";
const earlier = "2026-01-01T00:00:00.000Z";
const small = {
  id: "sample-small", variant: "Small", unit: "Box", ready: true, overridePhoto: "",
  rate: "11", purchase: "10.01", history: [{ at: earlier, rate: "11.00" }],
};
const large = {
  ...small, id: "sample-large", variant: "Large", rate: "15.02", history: [],
};
const draft = {
  id: "sample-quote", customerId: "sample-customer", lines: [
    { variantId: small.id, quantity: "3", rateOverride: "11.17" },
    { variantId: large.id, quantity: "2", rateOverride: "" },
  ],
};

function sampleWorkspace() {
  return structuredClone({
    schema: 3,
    departments: { Sample: ["Sample category"] },
    collections: ["Sample collection"],
    families: [{
      id: "sample-family", name: "Sample product", category: "Sample category",
      collections: ["Sample collection"], photo: "", gallery: [], variants: [small, large],
    }],
    customers: [
      { id: draft.customerId, name: "Synthetic Customer", phone: "910000000001", collection: "Full catalog", consent: true },
      { id: "second-customer", name: "Other Synthetic Customer", phone: "910000000002", collection: "Full catalog", consent: false },
    ],
  });
}

function withConfirmedQuote() {
  const workspace = sampleWorkspace();
  workspace.quoteDrafts = [structuredClone(draft)];
  const snapshot = buildQuoteSnapshot(workspace, workspace.quoteDrafts[0], at);
  const confirmed = { ...workspace, quoteDrafts: [], quoteSnapshots: [snapshot] };
  return { workspace, snapshot, confirmed };
}

test("Customer drafts retain independent overrides and exact, buyer-safe quotations", () => {
  const { workspace, snapshot, confirmed } = withConfirmedQuote();
  const otherDraft = {
    id: "other-quote", customerId: "second-customer",
    lines: [{ variantId: small.id, quantity: "1", rateOverride: "99.99" }],
  };
  workspace.quoteDrafts.push(otherDraft);
  confirmed.quoteDrafts.push(otherDraft);
  assert.ok(validQuoteTransition(workspace, confirmed));
  assert.equal(confirmed.quoteDrafts[0].lines[0].rateOverride, "99.99");
  assert.equal(workspace.families[0].variants[0].rate, "11");
  assert.deepEqual(snapshot.lines.map(({ rate, subtotal }) => ({ rate, subtotal })), [
    { rate: "11.17", subtotal: "33.51" }, { rate: "15.02", subtotal: "30.04" },
  ]);
  assert.equal(snapshot.total, "63.55");
  assert.equal(snapshot.customerName, "Synthetic Customer");
  assert.ok(quotableProducts(workspace).every((product) => !Object.hasOwn(product, "purchase")));
  assert.doesNotMatch(JSON.stringify(snapshot), /purchase|history|override|10\.01|99\.99/i);
  assert.match(quoteText(snapshot), /Total INR 63\.55/);
  assert.doesNotMatch(quoteText(snapshot), /91000000000[12]|purchase|10\.01|99\.99/);
});

test("Quote preview and export use the customer's current consent and recipient", () => {
  const { workspace, snapshot, confirmed } = withConfirmedQuote();
  assert.equal(quoteRecipientAllowed(workspace, snapshot), true);
  const changed = structuredClone(workspace);
  changed.customers[0].phone = "910000000003";
  assert.equal(quoteRecipientAllowed(changed, snapshot), false);
  assert.equal(validQuoteTransition(workspace, { ...confirmed, customers: changed.customers }), false);
  changed.customers[0].consent = false;
  assert.throws(() => buildQuoteSnapshot(changed, changed.quoteDrafts[0], at), /consent/);
  assert.equal(quoteRecipientAllowed(changed, snapshot), false);
  assert.equal(validQuoteTransition(changed, confirmed), false);
});

test("Confirm consumes the persisted draft and keeps snapshots immutable across master changes", () => {
  const { workspace, snapshot, confirmed } = withConfirmedQuote();
  assert.equal(validQuoteWorkspace(sampleWorkspace()), true);
  assert.equal(validQuoteTransition(sampleWorkspace(), confirmed), false);
  assert.equal(validQuoteTransition(workspace, { ...confirmed, quoteDrafts: workspace.quoteDrafts }), false);
  const edited = structuredClone(confirmed);
  edited.customers[0].name = "Renamed Synthetic Customer";
  edited.families[0].name = "Renamed synthetic item";
  edited.families[0].variants[1].rate = "45.00";
  assert.equal(validQuoteTransition(confirmed, edited), true);
  assert.equal(validQuoteTransition(workspace, edited), false);
  assert.match(quoteText(edited.quoteSnapshots[0]), /Synthetic Customer/);
  assert.doesNotMatch(quoteText(edited.quoteSnapshots[0]), /Renamed|45\.00/);
  const reordered = Object.fromEntries(Object.entries(snapshot).reverse());
  assert.equal(validQuoteTransition(confirmed, { ...edited, quoteSnapshots: [reordered] }), true);
  assert.equal(validQuoteTransition(confirmed, { ...edited, quoteSnapshots: [] }), false);
  assert.equal(validQuoteTransition(confirmed, {
    ...edited, quoteSnapshots: [{ ...snapshot, customerName: "Different Customer" }],
  }), false);
});

test("Rejects malformed drafts, unavailable items, and extra or manipulated snapshot fields", () => {
  const { workspace, snapshot, confirmed } = withConfirmedQuote();
  assert.equal(validQuoteWorkspace({ ...workspace, quoteDrafts: null }), false);
  assert.equal(validQuoteWorkspace({ ...workspace, quoteDrafts: [draft, { ...draft, id: "duplicate" }] }), false);
  assert.equal(validQuoteWorkspace({ ...workspace, quoteDrafts: [{ ...draft, customerId: "missing" }] }), false);
  assert.equal(validQuoteWorkspace({ ...workspace, quoteDrafts: [{ ...draft, lines: [{ ...draft.lines[0], quantity: "1.5" }] }] }), false);
  const removed = { ...workspace, families: [] };
  assert.equal(validQuoteWorkspace(removed), true);
  assert.throws(() => buildQuoteSnapshot(removed, draft, at), /unavailable/);
  assert.equal(validQuoteTransition(workspace, { ...confirmed, quoteSnapshots: [{ ...snapshot, purchase: "10" }] }), false);
  const adjusted = {
    ...snapshot,
    lines: [{ ...snapshot.lines[0], rate: "11.18", subtotal: "33.54" }, snapshot.lines[1]],
    total: "63.58",
  };
  assert.equal(validQuoteWorkspace({ ...confirmed, quoteSnapshots: [adjusted] }), true);
  assert.equal(validQuoteTransition(workspace, { ...confirmed, quoteSnapshots: [adjusted] }), false);
});

test("Bulk markup previews exact rounding and skips missing, unchanged, and out-of-range costs", () => {
  const workspace = sampleWorkspace();
  workspace.families[0].variants.push(
    { ...large, id: "sample-pending", purchase: "" },
    { ...large, id: "sample-expensive", purchase: "99999999.99" },
  );
  const preview = buildBulkPreview(workspace, [small.id, large.id, "sample-pending", "sample-expensive"], "50.00");
  assert.deepEqual(preview.rows.map(({ after, status }) => [after, status]), [
    ["15.02", "change"], ["15.02", "unchanged"], ["", "missing-cost"], ["", "out-of-range"],
  ]);
  assert.equal(markedUp("0.01", "50"), "0.02");
  assert.equal(markedUp("0.01", "49.99"), "0.01");
  assert.throws(() => buildBulkPreview(workspace, [], "50"), /Select at least one/);
  assert.throws(() => buildBulkPreview(workspace, [small.id], "1.111"), /markup/);
});

test("Bulk confirmation preserves history and rejects stale or tampered previews", () => {
  const workspace = sampleWorkspace();
  const preview = buildBulkPreview(workspace, [small.id, large.id], "100");
  const next = applyBulkMarkup(workspace, preview, at);
  const [afterSmall, afterLarge] = next.families[0].variants;
  assert.deepEqual(afterSmall.history, [{ at: earlier, rate: "11.00" }, { at, rate: "20.02" }]);
  assert.deepEqual(afterLarge.history, [{ at, rate: "15.02" }, { at, rate: "20.02" }]);
  assert.equal(afterSmall.purchase, "10.01");
  assert.deepEqual(workspace.families[0].variants, [small, large]);
  assert.throws(() => applyBulkMarkup(next, preview, at), /Prices changed/);
  const tampered = structuredClone(preview);
  tampered.rows[0].after = "0.01";
  assert.throws(() => applyBulkMarkup(workspace, tampered, at), /Prices changed/);
});
