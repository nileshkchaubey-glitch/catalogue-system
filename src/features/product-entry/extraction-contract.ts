// Future extraction providers produce proposals, never live catalogue records.
// Monetary values are decimal strings. Unknown is null, not an invented zero.
import type { ProductEntry, SellingUnit } from "./entry.ts";
import { newEntry, newRow, sellingUnits } from "./entry.ts";
export type Evidence = { sourceId: string; locator: string; excerpt?: string };
export type ProposedField<T> = { value: T | null; evidence: Evidence[]; confidence: number | null };
export type ExtractionProposalV1 = {
  schemaVersion: 1;
  proposalId: string;
  source: { id: string; kind: "supplier-sheet" | "invoice" | "product-photo"; sha256: string };
  products: Array<{
    name: ProposedField<string>; category: ProposedField<string>;
    variants: Array<{ size: ProposedField<string>; unit: ProposedField<string>;
      purchase: ProposedField<string>; selling: ProposedField<string> }>;
  }>;
};
// Accept only an explicit reviewed form of the proposal. Review decisions can
// override suggestions. No provider gets a direct write or publication path.
export type ReviewedProduct = {
  name: string; category: string; collections: string[];
  variants: { size: string; unit: SellingUnit; purchase: string | null; selling: string | null }[];
};
export function reviewedProductToEntry(review: ReviewedProduct): ProductEntry {
  if (!review.variants.length || review.variants.length > 200) throw Error("Review 1–200 variants.");
  const rows = review.variants.map(v => {
    if (!sellingUnits.includes(v.unit)) throw Error("Review the selling unit.");
    return { ...newRow(v.unit), variant: v.size, purchase: v.purchase ?? "", rate: v.selling ?? "" };
  });
  return { ...newEntry(review.category, review.collections), name: review.name, rows };
}
