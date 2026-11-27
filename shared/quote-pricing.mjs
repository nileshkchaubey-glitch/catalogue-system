const identifier = /^[a-zA-Z0-9-]{1,64}$/;
const amount = /^\d{1,8}(\.\d{1,2})?$/;
const quantity = /^[1-9]\d{0,5}$/;
const markup = /^\d{1,5}(\.\d{1,2})?$/;
const isoInstant = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const units = ["Piece", "Pack", "Box", "Carton", "Roll", "Set"];
const validId = (value) => typeof value === "string" && identifier.test(value);
const validQuantity = (value) => typeof value === "string" && quantity.test(value);
const textField = (value) => typeof value === "string" && value.length <= 100;
const distinct = (values) => new Set(values).size === values.length;
const hasKeys = (value, keys) =>
  value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validInstant = (value) =>
  typeof value === "string" && isoInstant.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function hundredths(value) {
  const [whole, part = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(part.padEnd(2, "0"));
}

function decimal(cents) {
  return String(cents / 100n) + "." + String(cents % 100n).padStart(2, "0");
}

export function validPrice(value) {
  return typeof value === "string" && amount.test(value) && hundredths(value) > 0n;
}

export function markedUp(cost, percent) {
  if (!validPrice(cost) || typeof percent !== "string" || !markup.test(percent)) return "";
  const cents = (hundredths(cost) * (10000n + hundredths(percent)) + 5000n) / 10000n;
  const result = decimal(cents);
  return validPrice(result) ? result : "";
}

// Postgres JSONB can return object keys in a different order from JavaScript.
function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(
    (key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]),
  );
}

function workspaceVariants(workspace) {
  return workspace.families.flatMap((family) =>
    family.variants.map((variant) => ({ ...variant, name: family.name })),
  );
}

export function quotableProducts(workspace) {
  return workspaceVariants(workspace).filter((variant) => variant.ready).map(
    ({ id, name, variant, rate, unit }) => ({ id, name, variant, rate, unit }),
  );
}

export function validQuoteLine(line) {
  return hasKeys(line, ["variantId", "quantity", "rateOverride"]) && validId(line.variantId) &&
    validQuantity(line.quantity) && (line.rateOverride === "" || validPrice(line.rateOverride));
}

function validDraft(draft) {
  return hasKeys(draft, ["id", "customerId", "lines"]) && validId(draft.id) &&
    validId(draft.customerId) && Array.isArray(draft.lines) && draft.lines.length <= 200 &&
    draft.lines.every(validQuoteLine) && distinct(draft.lines.map((line) => line.variantId));
}

function validSnapshotLine(line) {
  return hasKeys(line, ["variantId", "name", "variant", "unit", "quantity", "rate", "subtotal"]) &&
    validId(line.variantId) && textField(line.name) && !!line.name.trim() &&
    textField(line.variant) && units.includes(line.unit) && validQuantity(line.quantity) &&
    validPrice(line.rate) && line.rate === decimal(hundredths(line.rate)) &&
    line.subtotal === decimal(hundredths(line.rate) * BigInt(line.quantity));
}

function validSnapshot(snapshot) {
  return hasKeys(snapshot, ["id", "customerId", "customerName", "customerPhone", "confirmedAt", "lines", "total"]) &&
    validId(snapshot.id) && validId(snapshot.customerId) && textField(snapshot.customerName) &&
    !!snapshot.customerName.trim() && typeof snapshot.customerPhone === "string" &&
    /^\d{8,15}$/.test(snapshot.customerPhone) && validInstant(snapshot.confirmedAt) &&
    Array.isArray(snapshot.lines) && snapshot.lines.length > 0 && snapshot.lines.length <= 200 &&
    snapshot.lines.every(validSnapshotLine) && distinct(snapshot.lines.map((line) => line.variantId)) &&
    snapshot.total === decimal(snapshot.lines.reduce((sum, line) => sum + hundredths(line.subtotal), 0n));
}

export function validQuoteWorkspace(workspace) {
  const drafts = workspace.quoteDrafts === undefined ? [] : workspace.quoteDrafts;
  const snapshots = workspace.quoteSnapshots === undefined ? [] : workspace.quoteSnapshots;
  return Array.isArray(drafts) && Array.isArray(snapshots) &&
    drafts.every(validDraft) && snapshots.every(validSnapshot) &&
    distinct(drafts.map((draft) => draft.customerId)) &&
    distinct([...drafts, ...snapshots].map((quote) => quote.id)) &&
    drafts.every((draft) => workspace.customers.some(({ id }) => id === draft.customerId));
}

export function buildQuoteSnapshot(workspace, draft, confirmedAt) {
  if (!validDraft(draft) || !draft.lines.length || !validInstant(confirmedAt)) {
    throw Error("Add at least one valid item to the quotation.");
  }
  const customer = workspace.customers.find(({ id }) => id === draft.customerId);
  if (!customer?.consent) throw Error("Record the customer's consent before previewing the quotation.");
  const variants = new Map(quotableProducts(workspace).map((product) => [product.id, product]));
  let total = 0n;
  const lines = draft.lines.map((line) => {
    const product = variants.get(line.variantId);
    if (!product) throw Error("Remove unavailable products from this draft before previewing it.");
    const rate = line.rateOverride || product.rate;
    if (!validPrice(rate)) throw Error(`Enter a rate for ${product.name}.`);
    const cents = hundredths(rate);
    const subtotal = cents * BigInt(line.quantity);
    total += subtotal;
    return {
      variantId: product.id,
      name: product.name,
      variant: product.variant,
      unit: product.unit,
      quantity: line.quantity,
      rate: decimal(cents),
      subtotal: decimal(subtotal),
    };
  });
  return {
    id: draft.id,
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    confirmedAt,
    lines,
    total: decimal(total),
  };
}

export function validQuoteTransition(previous, next) {
  if (!validQuoteWorkspace(next)) return false;
  const priorSnapshots = previous.quoteSnapshots ?? [];
  const nextSnapshots = next.quoteSnapshots ?? [];
  const added = nextSnapshots.length - priorSnapshots.length;
  if (added < 0 || added > 1 || !priorSnapshots.every((quote, index) => sameValue(quote, nextSnapshots[index]))) {
    return false;
  }
  if (!added) return true;
  const snapshot = nextSnapshots.at(-1);
  const draft = previous.quoteDrafts?.find((entry) => entry.id === snapshot.id);
  const remainingDrafts = previous.quoteDrafts?.filter((entry) => entry.id !== snapshot.id);
  if (!draft || !sameValue(remainingDrafts, next.quoteDrafts ?? [])) return false;
  try {
    return sameValue(snapshot, buildQuoteSnapshot(previous, draft, snapshot.confirmedAt)) &&
      sameValue(snapshot, buildQuoteSnapshot(next, draft, snapshot.confirmedAt));
  } catch {
    return false;
  }
}

export function quoteRecipientAllowed(workspace, snapshot) {
  return workspace.customers.some((customer) => customer.id === snapshot.customerId &&
    customer.phone === snapshot.customerPhone && customer.consent);
}

export function quoteText(snapshot) {
  const singleLine = (value) => value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").trim();
  return [
    `Quotation ${snapshot.id}`,
    `Prepared for ${singleLine(snapshot.customerName)}`,
    snapshot.confirmedAt.slice(0, 10),
    "",
    ...snapshot.lines.map((line) => {
      const item = [line.name, line.variant].map(singleLine).filter(Boolean).join(" · ");
      return `${item} — ${line.quantity} × INR ${line.rate} per ${line.unit.toLowerCase()} = INR ${line.subtotal}`;
    }),
    "",
    `Total INR ${snapshot.total}`,
  ].join("\n");
}

export function buildBulkPreview(workspace, variantIds, percent) {
  if (typeof percent !== "string" || !markup.test(percent)) {
    throw Error("Enter a non-negative markup with up to two decimal places.");
  }
  const ids = new Set(variantIds);
  if (!ids.size) throw Error("Select at least one item for the markup.");
  const rows = workspaceVariants(workspace).filter((variant) => ids.has(variant.id)).map((variant) => {
    const next = markedUp(variant.purchase, percent);
    return {
      id: variant.id,
      name: variant.name,
      variant: variant.variant,
      purchase: variant.purchase,
      before: variant.rate,
      after: next,
      status: !next ? (variant.purchase ? "out-of-range" : "missing-cost") :
        validPrice(variant.rate) && hundredths(variant.rate) === hundredths(next) ? "unchanged" : "change",
    };
  });
  if (rows.length !== ids.size) throw Error("The selected items changed. Review the markup again.");
  return { percent, rows };
}

export function applyBulkMarkup(workspace, preview, at) {
  const current = buildBulkPreview(workspace, preview.rows.map(({ id }) => id), preview.percent);
  if (!sameValue(current, preview)) throw Error("Prices changed. Review the markup again.");
  if (!validInstant(at)) throw Error("The rate change time is invalid.");
  const changed = new Map(current.rows.filter((row) => row.status === "change").map((row) => [row.id, row.after]));
  if (!changed.size) throw Error("The selected items have no new rates to apply.");
  return {
    ...workspace,
    families: workspace.families.map((family) => {
      if (!family.variants.some(({ id }) => changed.has(id))) return family;
      return {
        ...family,
        variants: family.variants.map((variant) => {
          const rate = changed.get(variant.id);
          if (!rate) return variant;
          const last = variant.history.at(-1)?.rate;
          const previousRateRecorded = validPrice(last) && validPrice(variant.rate) &&
            hundredths(last) === hundredths(variant.rate);
          const previous = variant.rate && !previousRateRecorded ? [{ at, rate: variant.rate }] : [];
          return { ...variant, rate, history: [...variant.history, ...previous, { at, rate }] };
        }),
      };
    }),
  };
}
