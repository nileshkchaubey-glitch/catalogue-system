import type { Workspace } from "../src/model";

export type QuoteLine = {
  variantId: string;
  quantity: string;
  rateOverride: string;
};

export type QuoteDraft = {
  id: string;
  customerId: string;
  lines: QuoteLine[];
};

export type QuoteSnapshot = {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  confirmedAt: string;
  lines: {
    variantId: string;
    name: string;
    variant: string;
    unit: string;
    quantity: string;
    rate: string;
    subtotal: string;
  }[];
  total: string;
};

export type BulkPreview = {
  percent: string;
  rows: {
    id: string;
    name: string;
    variant: string;
    purchase: string;
    before: string;
    after: string;
    status: "change" | "missing-cost" | "out-of-range" | "unchanged";
  }[];
};

export function validPrice(value: unknown): value is string;
export function markedUp(cost: string, percent: string): string;
export function quotableProducts(workspace: Workspace): {
  id: string;
  name: string;
  variant: string;
  rate: string;
  unit: string;
}[];
export function validQuoteLine(line: QuoteLine): boolean;
export function validQuoteWorkspace(workspace: Workspace): boolean;
export function buildQuoteSnapshot(workspace: Workspace, draft: QuoteDraft, confirmedAt: string): QuoteSnapshot;
export function validQuoteTransition(previous: Workspace, next: Workspace): boolean;
export function quoteRecipientAllowed(workspace: Workspace, snapshot: QuoteSnapshot): boolean;
export function quoteText(snapshot: QuoteSnapshot): string;
export function buildBulkPreview(workspace: Workspace, variantIds: string[], percent: string): BulkPreview;
export function applyBulkMarkup(workspace: Workspace, preview: BulkPreview, at: string): Workspace;
