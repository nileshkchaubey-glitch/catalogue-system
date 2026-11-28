import { prepareFamily } from "./editor.ts";
import { departmentNames, english } from "./model.ts";
import type { Family, Variant, Workspace } from "./model.ts";
import { validPrice } from "./pricing.ts";

export const productsSheet = "Products";
export const excelColumns = ["Product ID", "Variant ID", "Product name", "Category", "Variant", "Unit", "Purchase price (INR)", "Selling price (INR)"];
const units = ["Piece", "Pack", "Box", "Carton", "Roll", "Set"];
const maxImportRows = 2_000;
type ExcelRow = readonly unknown[];

export type ExcelPreview = {
  workspace: Workspace;
  rows: number;
  products: { name: string; isNew: boolean }[];
};

export function productExcelRows(workspace: Workspace, template: boolean) {
  return [excelColumns, ...(template ? [] : workspace.families.flatMap((product) =>
    product.variants.map((variant) => [
      product.id, variant.id, product.name, product.category, variant.variant, variant.unit,
      variant.purchase ? Number(variant.purchase) : null, variant.rate ? Number(variant.rate) : null,
    ]),
  ))];
}

export function excelReferenceRows(workspace: Workspace) {
  return [
    ["Department", "Category", "Unit"],
    ...departmentNames(workspace.departments, workspace.departmentOrder).flatMap((department) =>
      workspace.departments[department].map((category) => [department, category, null]),
    ),
    ...units.map((unit) => [null, null, unit]),
  ];
}

function text(cell: unknown, label: string) {
  if (cell == null) return "";
  if (typeof cell !== "string") throw Error(`${label} must be text.`);
  return cell.trim();
}

function price(cell: unknown, label: string) {
  const value = typeof cell === "number" ? String(cell) : text(cell, label);
  if (value && !validPrice(value)) throw Error(`${label} must be positive with up to two decimal places.`);
  return value;
}

type ProductDraft = {
  original?: Family;
  family: Family;
  rows: number[];
  editedVariants: Map<string, number>;
};

export function previewCatalogueExcel(workspace: Workspace, sheet: ExcelRow[], now: string): ExcelPreview {
  const [header, ...rows] = sheet;
  if (!header || header.length !== excelColumns.length ||
      !excelColumns.every((column, index) => header[index] === column)) {
    throw Error("Use the Products sheet from the Catalogue Studio Excel template and keep the column headers.");
  }
  if (rows.length > maxImportRows) throw Error(`Import up to ${maxImportRows} rows at a time. Split this workbook into smaller batches.`);

  const categories = new Map(Object.values(workspace.departments).flat().map((name) => [name.toLowerCase(), name]));
  const existingById = new Map(workspace.families.map((family) => [family.id, family]));
  const nameKey = (category: string, name: string) => JSON.stringify([category, name.toLowerCase()]);
  const existingNames = new Set(workspace.families.map((family) => nameKey(family.category, family.name)));
  const drafts = new Map<string, ProductDraft>();
  const issues: string[] = [];
  let rowCount = 0;

  for (const [index, row] of rows.entries()) {
    if (row.every((cell) => cell == null || (typeof cell === "string" && !cell.trim()))) continue;
    const number = index + 2;
    rowCount++;
    try {
      if (row.slice(excelColumns.length).some((cell) => cell != null && cell !== "")) throw Error("Remove values beyond the template columns.");
      const productId = text(row[0], "Product ID");
      const variantId = text(row[1], "Variant ID");
      const name = text(row[2], "Product name");
      const category = categories.get(text(row[3], "Category").toLowerCase());
      const variant = typeof row[4] === "number" ? String(row[4]) : text(row[4], "Variant");
      const unit = units.find((item) => item.toLowerCase() === text(row[5], "Unit").toLowerCase());
      const purchase = price(row[6], "Purchase price");
      const rate = price(row[7], "Selling price");
      if (!name || name.length > 100 || !english(name)) throw Error("Enter a product name in English, up to 100 characters.");
      if (!category) throw Error("Choose an existing category from the Reference sheet.");
      if (variant.length > 100 || !english(variant)) throw Error("Enter the variant in English, up to 100 characters.");
      if (!unit) throw Error("Choose a unit from the Reference sheet.");
      const original = existingById.get(productId);
      if (productId && !original) throw Error("Product ID is unknown. Use the ID from an export or leave both IDs blank for a new product.");
      const previous = original?.variants.find((item) => item.id === variantId);
      if (variantId && !previous) throw Error("Variant ID does not belong to this product.");
      const key = productId || nameKey(category, name);
      if (!original && existingNames.has(key)) throw Error("This product already exists in the category. Use its IDs from an export.");
      const draft = drafts.get(key) ?? {
        original,
        family: original
          ? { ...original, name, category, variants: [...original.variants] }
          : { id: crypto.randomUUID(), name, category, photo: "", gallery: [], collections: [], variants: [] },
        rows: [],
        editedVariants: new Map<string, number>(),
      };
      if (draft.family.name !== name || draft.family.category !== category) throw Error("Rows for the same product must agree on its name and category.");
      if (variantId && draft.editedVariants.has(variantId)) throw Error("This Variant ID appears more than once.");
      const next: Variant = {
        ...(previous ?? { id: crypto.randomUUID(), ready: false, overridePhoto: "", history: [] }),
        variant, unit,
        purchase: purchase || previous?.purchase || "",
        rate: rate || previous?.rate || "",
      };
      if (previous) {
        draft.family.variants[draft.family.variants.findIndex((item) => item.id === previous.id)] = next;
      } else {
        draft.family.variants.push(next);
      }
      draft.rows.push(number);
      draft.editedVariants.set(next.id, number);
      drafts.set(key, draft);
    } catch (error) {
      issues.push(`Row ${number}. ${(error as Error).message}`);
    }
  }

  if (!rowCount) throw Error("The Products sheet does not contain any product rows.");
  const edits = new Map<string, Family>();
  const additions: Family[] = [];
  const products: ExcelPreview["products"] = [];
  for (const { family, original, rows: sheetRows, editedVariants } of drafts.values()) {
    const prepared = prepareFamily(family, original, now);
    if ("error" in prepared) {
      const sourceRow = (prepared.variantId && editedVariants.get(prepared.variantId)) || sheetRows[0];
      issues.push(`Row ${sourceRow}. ${prepared.error}`);
      continue;
    }
    const next = prepared.family;
    if (original) {
      const originals = new Map(original.variants.map((item) => [item.id, item]));
      next.variants = next.variants.map((item) => {
        const previous = originals.get(item.id);
        if (!previous) return item;
        if (!editedVariants.has(item.id)) return previous;
        return Number(item.purchase) === Number(previous.purchase) ? { ...item, purchase: previous.purchase } : item;
      });
      if (JSON.stringify(next) === JSON.stringify(original)) continue;
      edits.set(next.id, next);
    } else {
      additions.push(next);
    }
    products.push({ name: next.name, isNew: !original });
  }
  if (issues.length) {
    const firstIssues = issues.slice(0, 8).join("\n");
    throw Error(issues.length > 8 ? `${firstIssues}\n${issues.length - 8} more issues in this workbook.` : firstIssues);
  }
  return {
    workspace: { ...workspace, families: [...workspace.families.map((family) => edits.get(family.id) ?? family), ...additions] },
    rows: rowCount,
    products,
  };
}
