import { prepareFamily } from "../../editor.ts";
import type { Family, Variant, Workspace } from "../../model.ts";

export const sellingUnits = ["Piece", "Pack", "Box", "Carton", "Roll", "Set"] as const;
export type SellingUnit = typeof sellingUnits[number];
export type EntryRow = { id: string; variant: string; unit: SellingUnit; purchase: string; rate: string };
export type ProductEntry = { name: string; category: string; collections: string[]; photo: string; gallery: string[]; rows: EntryRow[] };
export const newRow = (unit: SellingUnit = "Piece"): EntryRow => ({ id: crypto.randomUUID(), variant: "", unit, purchase: "", rate: "" });
export function newEntry(category: string, collections: string[] = [], unit: SellingUnit = "Piece"): ProductEntry {
  return { name: "", category, collections: [...collections], photo: "", gallery: [], rows: [newRow(unit)] };
}
export function duplicateEntry(family: Family, reuseImages: boolean): ProductEntry {
  return {
    name: "", category: family.category, collections: [...family.collections],
    photo: reuseImages ? family.photo : "", gallery: reuseImages ? [...family.gallery] : [],
    rows: family.variants.map(v => ({ ...newRow(sellingUnits.includes(v.unit as SellingUnit) ? v.unit as SellingUnit : "Piece"), variant: v.variant })),
  };
}
export function parseVariantPaste(source: string, defaultUnit: SellingUnit): EntryRow[] {
  if (source.length > 100_000) throw Error("Paste up to 200 variant rows at a time.");
  const rows = source.replace(/\r\n/g, "\n").split("\n").filter(s => s.trim());
  if (!rows.length || rows.length > 200) throw Error("Paste 1–200 variant rows.");
  return rows.map((line, i) => {
    const cells = line.split("\t");
    if (cells.length > 4) throw Error("Row " + (i + 1) + ": expected Size, Unit, Purchase, Selling.");
    const [variant = "", unitText = "", purchase = "", rate = ""] = cells.map(s => s.trim());
    const unit = unitText ? sellingUnits.find(v => v.toLowerCase() === unitText.toLowerCase()) : defaultUnit;
    if (!unit) throw Error("Row " + (i + 1) + ": unknown selling unit.");
    return { ...newRow(unit), variant, purchase, rate };
  });
}
// Pure domain service: all new records remain private until explicitly verified.
// Preserve existing workspace fields and the current revision-protected save path.
export function prepareNewProduct(workspace: Workspace, draft: ProductEntry, at: string): Workspace {
  if (!Object.values(workspace.departments).some(categories => categories.includes(draft.category))) throw Error("Select an existing category.");
  if (!draft.rows.length || draft.rows.length > 200) throw Error("Enter 1–200 variants.");
  if (draft.name.trim().length > 100 || draft.rows.some(r => r.variant.trim().length > 100)) throw Error("Product and size names must be up to 100 characters.");
  if (new Set(draft.rows.map(r => r.id)).size !== draft.rows.length) throw Error("Variant IDs must be distinct.");
  if (draft.collections.some(c => !workspace.collections.includes(c))) throw Error("Choose existing collections.");
  if (workspace.families.some(f => f.category === draft.category && f.name.trim().toLowerCase() === draft.name.trim().toLowerCase())) throw Error("A product with this name already exists in this category. Edit the existing product.");
  const existingIds = new Set(workspace.families.flatMap(f => [f.id, ...f.variants.map(v => v.id)]));
  if (draft.rows.some(r => existingIds.has(r.id) || !sellingUnits.includes(r.unit))) throw Error("Invalid or existing variant ID or unit.");
  const variants: Variant[] = draft.rows.map(r => ({ id: r.id, variant: r.variant, unit: r.unit, purchase: r.purchase, rate: r.rate, ready: false, history: [], overridePhoto: "" }));
  const family: Family = { id: crypto.randomUUID(), name: draft.name, category: draft.category, collections: [...new Set(draft.collections)], photo: draft.photo, gallery: [...draft.gallery], variants };
  const prepared = prepareFamily(family, undefined, at);
  if ("error" in prepared) {
    const row = draft.rows.findIndex(r => r.id === prepared.variantId);
    throw Error((row < 0 ? "" : "Variant " + (row + 1) + ": ") + prepared.error);
  }
  return { ...workspace, families: [...workspace.families, prepared.family] };
}
