import assert from "node:assert/strict";
import test from "node:test";
import { readSheet } from "read-excel-file/node";
import writeExcelFile from "write-excel-file/node";
import { excelColumns, excelReferenceRows, previewCatalogueExcel, productExcelRows, productsSheet } from "../src/catalogue-excel.ts";

const at = "2026-11-28T09:00:00.000Z";
const before = "2026-11-28T08:00:00.000Z";
const media = "/api/photos/" + "a".repeat(64);
const saved = {
  id: "tray", name: "Storage tray", category: "Trays", photo: media, gallery: ["/api/photos/" + "b".repeat(64)],
  collections: ["Wholesale"],
  variants: [
    { id: "tray-regular", variant: "Regular", unit: "Pack", purchase: "03.00", rate: "5", history: [{ at: before, rate: "5" }], ready: true, overridePhoto: "" },
    { id: "tray-large", variant: "Large", unit: "Pack", purchase: "4.00", rate: "7.00", history: [], ready: false, overridePhoto: "" },
  ],
};
const workspace = {
  schema: 3, departments: { Storage: ["Trays"], Packaging: ["Boxes"] }, departmentOrder: ["Packaging", "Storage"],
  families: [saved], customers: [], collections: ["Wholesale"], quoteDrafts: [], quoteSnapshots: [],
};
const row = (cells) => [excelColumns, ...cells];

test("a written Excel workbook round-trips without changing prices, gallery, or history", async () => {
  const data = (rows) => rows.map((line) => line.map((value) => value == null ? null : { value, type: typeof value === "number" ? Number : String }));
  const book = await writeExcelFile([
    { sheet: productsSheet, data: data(productExcelRows(workspace, false)) },
    { sheet: "Reference", data: data(excelReferenceRows(workspace)) },
  ]).toBuffer();
  assert.equal((await readSheet(book, "Reference"))[1][1], "Boxes");
  const preview = previewCatalogueExcel(workspace, await readSheet(book, productsSheet), at);
  assert.equal(preview.rows, 2);
  assert.deepEqual(preview.products, []);
  assert.deepEqual(preview.workspace, workspace);
  assert.deepEqual(productExcelRows(workspace, true), [excelColumns]);
});

test("Excel groups new variants and updates matching IDs while preserving unedited fields", () => {
  const preview = previewCatalogueExcel(workspace, row([
    ["tray", "tray-regular", "Storage tray", "Trays", "Regular", "Pack", null, 6.2],
    [null, null, "Archive box", "Boxes", 250, "Box", 2, null],
    [null, null, "Archive box", "Boxes", 500, "Box", 3.35, 5.5],
  ]), at);
  assert.deepEqual(preview.products, [
    { name: "Storage tray", isNew: false }, { name: "Archive box", isNew: true },
  ]);
  const [updated, created] = preview.workspace.families;
  assert.equal(updated.photo, saved.photo);
  assert.deepEqual(updated.gallery, saved.gallery);
  assert.deepEqual(updated.collections, saved.collections);
  assert.strictEqual(updated.variants[1], saved.variants[1]);
  assert.equal(updated.variants[0].purchase, "03.00");
  assert.equal(updated.variants[0].ready, true);
  assert.deepEqual(updated.variants[0].history, [{ at: before, rate: "5" }, { at, rate: "6.20" }]);
  assert.deepEqual(created.variants.map(v => [v.variant, v.purchase, v.rate, v.ready]), [
    ["250", "2.00", "", false], ["500", "3.35", "5.50", false],
  ]);
  assert.strictEqual(preview.workspace.quoteSnapshots, workspace.quoteSnapshots);
  assert.equal(workspace.families.length, 1);
});

test("Excel rejects bad rows together and avoids silently duplicating existing items", () => {
  const before = JSON.stringify(workspace);
  const source = row([
    [null, null, "New box", "Boxes", "Large", "Box", null, 9],
    [null, null, "Storage tray", "Trays", "Regular", "Pack", null, 8],
    ["tray", "wrong-variant", "Storage tray", "Trays", "Regular", "Pack", null, 8],
    [null, null, "Invalid size", "Unknown", "Regular", "Pack", null, 8],
    [null, null, "Invalid price", "Boxes", "Regular", "Pack", null, "3.999"],
  ]);
  assert.throws(() => previewCatalogueExcel(workspace, source, at), (error) => {
    assert.match(error.message, /Row 3.*already exists/);
    assert.match(error.message, /Row 4.*does not belong/);
    assert.match(error.message, /Row 5.*existing category/);
    assert.match(error.message, /Row 6.*two decimal places/);
    return true;
  });
  assert.equal(JSON.stringify(workspace), before);
  assert.throws(() => previewCatalogueExcel(workspace, row([
    [null, null, "Duplicate sizes", "Trays", "Regular", "Pack", null, 8],
    [null, null, "Duplicate sizes", "Trays", "regular", "Pack", null, 9],
  ]), at), /Row 3.*distinct name/);
});
