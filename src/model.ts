import taxonomy from "../shared/taxonomy.json" with { type: "json" };
import type { QuoteDraft, QuoteSnapshot } from "../shared/quote-pricing.mjs";
export const departments: Record<string, string[]> = taxonomy.departments;
export const categories = Object.values(departments).flat();
// JSONB preserves arrays, not object insertion order. Old workspaces have
// no explicit order; keep their received order until the owner saves it.
export const departmentNames = (tree: Workspace["departments"], order?: string[]) =>
  order ?? Object.keys(tree);
export const departmentOf = (tree: Workspace["departments"], category: string) =>
  Object.entries(tree).find(([, names]) => names.includes(category))?.[0] ?? "";
export const fullCatalog = "Full catalog";
export const featuredCollection = "Restaurant & Takeaway";
export type Collection = string;
export type Variant = {
  id: string;
  variant: string;
  unit: string;
  overridePhoto: string;
  purchase: string;
  ready: boolean;
  rate: string;
  history: { at: string; rate: string }[];
};
export type Family = {
  id: string;
  name: string;
  category: string;
  photo: string;
  gallery: string[];
  collections: string[];
  variants: Variant[];
};
export type Product = Variant & {
  familyId: string;
  name: string;
  category: string;
  photo: string;
  collections: string[];
};
export const variantsOf = (family: Family): Product[] =>
  family.variants.map((v) => ({
    ...v,
    familyId: family.id,
    name: family.name,
    category: family.category,
    collections: family.collections,
    photo: v.overridePhoto || family.photo,
  }));
export type Customer = {
  id: string;
  name: string;
  phone: string;
  collection: Collection;
  consent: boolean;
};
export type Workspace = {
  schema: 3;
  departments: Record<string, string[]>;
  departmentOrder?: string[];
  families: Family[];
  customers: Customer[];
  collections: string[];
  quoteDrafts?: QuoteDraft[];
  quoteSnapshots?: QuoteSnapshot[];
};
export const empty: Workspace = {
  schema: 3,
  departments,
  families: [],
  customers: [],
  collections: Object.keys(taxonomy.legacyCollections),
};
export const money = (rate: string) =>
  rate
    ? new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
      }).format(Number(rate))
    : "Rate pending";
export const english = (s: string) =>
  !Array.from(s).some(
    (ch) => /\p{L}/u.test(ch) && !/[\p{Script=Latin}]/u.test(ch),
  );
export const digits = (s: string) => {
  const raw = s.replace(/[\s()-]/g, "");
  return /^\d{10}$/.test(raw) ? "91" + raw : raw.replace(/^\+/, "");
};
export const buyerLink = (collection: Collection) =>
  location.origin + "/buyer?collection=" + encodeURIComponent(collection);
export async function photograph(file: File): Promise<string> {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size > 16 * 1024 * 1024
  )
    throw Error("Choose a JPG, PNG or WebP image under 16 MB.");
  const bmp = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 700 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw Error("Photo processing is unavailable.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.76);
  } finally {
    bmp.close();
  }
}

export async function uploadImage(file: File, profileId: string) {
  const photo = await photograph(file);
  const bytes = await (await fetch(photo)).blob();
  const res = await fetch("/api/photos", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", "X-Owner-Profile": profileId },
    body: bytes,
  });
  if (!res.ok) throw Error("Photo upload failed. Retry the selected file.");
  return (await res.json()).photo as string;
}
