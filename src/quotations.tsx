import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  buildQuoteSnapshot,
  quoteRecipientAllowed,
  quoteText,
  quotableProducts,
  validQuoteLine,
} from "../shared/quote-pricing.mjs";
import type { QuoteDraft, QuoteLine, QuoteSnapshot } from "../shared/quote-pricing.mjs";
import { money } from "./model";
import type { Workspace } from "./model";

function newDraft(customerId: string): QuoteDraft {
  return { id: crypto.randomUUID(), customerId, lines: [] };
}

export function QuotationForm({ workspace, customerId, save }: {
  workspace: Workspace;
  customerId: string;
  save: (workspace: Workspace, message: string) => Promise<void | boolean>;
}) {
  const savedDraft = workspace.quoteDrafts?.find((draft) => draft.customerId === customerId);
  const [draft, setDraft] = useState(() => savedDraft ?? newDraft(customerId));
  const [variantId, setVariantId] = useState("");
  const [preview, setPreview] = useState<QuoteSnapshot | null>(null);
  const [consent, setConsent] = useState(false);
  const [openedQuoteId, setOpenedQuoteId] = useState("");
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState("");
  const [notice, setNotice] = useState("");
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const itemPicker = useRef<HTMLSelectElement>(null);
  const returningToDraft = useRef(false);
  const customer = workspace.customers.find((person) => person.id === customerId);
  const products = quotableProducts(workspace);
  const productsById = new Map(products.map((product) => [product.id, product]));
  const chosen = new Set(draft.lines.map((line) => line.variantId));
  const saved = savedDraft?.id === draft.id && savedDraft.lines.length === draft.lines.length &&
    savedDraft.lines.every((line, index) => {
      const current = draft.lines[index];
      return line.variantId === current.variantId && line.quantity === current.quantity &&
        line.rateOverride === current.rateOverride;
    });
  const history = (workspace.quoteSnapshots ?? []).filter((quote) => quote.customerId === customerId).reverse();
  const openedQuote = history.find((quote) => quote.id === openedQuoteId);
  const review = preview ?? openedQuote;
  const isPreview = preview !== null;
  const canExport = !!openedQuote && quoteRecipientAllowed(workspace, openedQuote);

  useEffect(() => {
    if (review?.id) {
      reviewHeading.current?.focus();
    } else if (returningToDraft.current) {
      itemPicker.current?.focus();
      returningToDraft.current = false;
    }
  }, [review?.id, isPreview]);

  function changeLines(lines: QuoteLine[]) {
    setDraft({ ...draft, lines });
    setIssue("");
    setNotice("");
  }

  function changeLine(id: string, patch: Partial<QuoteLine>) {
    changeLines(draft.lines.map((line) => line.variantId === id ? { ...line, ...patch } : line));
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    if (busy || saved || (!savedDraft && !draft.lines.length)) return;
    if (!draft.lines.every(validQuoteLine)) {
      setIssue("Use a whole quantity from 1 to 999999 and a positive override rate with up to two decimal places.");
      return;
    }
    setBusy(true);
    setIssue("");
    setNotice("");
    try {
      const drafts = (workspace.quoteDrafts ?? []).filter((entry) => entry.customerId !== customerId);
      if (await save({ ...workspace, quoteDrafts: [...drafts, draft] }, "Quotation draft saved.") === false) return;
      setNotice("Quotation draft saved.");
    } catch (error) {
      setIssue((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openPreview() {
    if (!saved || !savedDraft) return;
    setIssue("");
    setNotice("");
    setConsent(false);
    try {
      setPreview(buildQuoteSnapshot(workspace, savedDraft, new Date().toISOString()));
    } catch (error) {
      setIssue((error as Error).message);
    }
  }

  async function confirmQuotation(event: FormEvent) {
    event.preventDefault();
    if (!preview || !consent || !quoteRecipientAllowed(workspace, preview) || busy) return;
    setBusy(true);
    setIssue("");
    try {
      const next = {
        ...workspace,
        quoteDrafts: (workspace.quoteDrafts ?? []).filter((entry) => entry.id !== preview.id),
        quoteSnapshots: [...(workspace.quoteSnapshots ?? []), preview],
      };
      if (await save(next, "Quotation confirmed.") === false) return;
      setOpenedQuoteId(preview.id);
      setDraft(newDraft(customerId));
      setPreview(null);
      setConsent(false);
      setNotice("Quotation confirmed.");
    } catch (error) {
      setIssue((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function backToDraft() {
    returningToDraft.current = true;
    setOpenedQuoteId("");
    setPreview(null);
    setConsent(false);
    setIssue("");
    setNotice("");
  }

  async function copyQuotation() {
    if (!openedQuote || !canExport) return;
    setIssue("");
    setNotice("");
    try {
      await navigator.clipboard.writeText(quoteText(openedQuote));
      setNotice("Quotation copied.");
    } catch {
      setIssue("Clipboard access is unavailable. Download the quotation as text.");
    }
  }

  function downloadQuotation() {
    if (!openedQuote || !canExport) return;
    const url = URL.createObjectURL(new Blob([quoteText(openedQuote)], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `quotation-${openedQuote.id}.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!customer) return <div className="draft"><p role="alert">This customer is unavailable.</p></div>;

  if (review) return (
    <form onSubmit={confirmQuotation}>
      <h3 ref={reviewHeading} tabIndex={-1}>{preview ? "Quotation preview" : "Confirmed quotation"}</h3>
      <p>Recipient {review.customerName} · +{review.customerPhone}</p>
      <div className="draft quote-text"><pre>{quoteText(review)}</pre></div>
      {preview && (
        <label className="check">
          <input
            type="checkbox"
            checked={consent}
            disabled={busy || !quoteRecipientAllowed(workspace, preview)}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>I verified that this customer agreed to receive this quotation at the displayed number.</span>
        </label>
      )}
      {!quoteRecipientAllowed(workspace, review) && (
        <p role="alert">The customer’s number or consent changed. Review their current contact details.</p>
      )}
      {issue && <p role="alert">{issue}</p>}
      {notice && <p role="status">{notice}</p>}
      {canExport && (
        <div className="card-actions">
          <button type="button" className="secondary" onClick={() => void copyQuotation()}>Copy quotation</button>
          <button type="button" className="secondary" onClick={downloadQuotation}>Download quotation</button>
        </div>
      )}
      <footer>
        <button type="button" className="secondary" disabled={busy} onClick={backToDraft}>Back to draft</button>
        {preview && (
          <button className="primary" disabled={busy || !consent || !quoteRecipientAllowed(workspace, preview)}>
            {busy ? "Saving…" : "Confirm quotation"}
          </button>
        )}
      </footer>
    </form>
  );

  return (
    <form onSubmit={saveDraft} noValidate>
      <p><strong>{customer.name}</strong> · +{customer.phone}</p>
      {!customer.consent && <p className="notice">Record the customer’s consent in their contact before previewing.</p>}
      <label>
        Product or size
        <select ref={itemPicker} value={variantId} onChange={(event) => setVariantId(event.target.value)} disabled={busy}>
          <option value="">Choose a verified item</option>
          {products.filter((product) => !chosen.has(product.id)).map((product) => (
            <option key={product.id} value={product.id}>
              {[product.name, product.variant, product.unit].filter(Boolean).join(" · ")}
            </option>
          ))}
        </select>
      </label>
      <div className="card-actions">
        <button type="button" className="secondary" disabled={!productsById.has(variantId) || busy || draft.lines.length >= 200} onClick={() => {
          if (!productsById.has(variantId) || chosen.has(variantId)) return;
          changeLines([...draft.lines, { variantId, quantity: "1", rateOverride: "" }]);
          setVariantId("");
        }}>Add item</button>
      </div>
      {draft.lines.map((line) => {
        const product = productsById.get(line.variantId);
        const label = product ? [product.name, product.variant].filter(Boolean).join(" · ") : "Unavailable product";
        return (
          <section className="sizebox" key={line.variantId} aria-label={label}>
            <strong>{label}</strong>
            {product && <small>Master rate {money(product.rate)} per {product.unit.toLowerCase()}</small>}
            <div className="pair">
              <label>
                Quantity
                <input inputMode="numeric" maxLength={6} value={line.quantity} disabled={busy}
                  onChange={(event) => changeLine(line.variantId, { quantity: event.target.value })} />
              </label>
              <label>
                Override rate (INR)
                <input inputMode="decimal" maxLength={11} value={line.rateOverride} disabled={busy}
                  placeholder="Use master rate"
                  onChange={(event) => changeLine(line.variantId, { rateOverride: event.target.value })} />
              </label>
            </div>
            <div className="card-actions">
              <button type="button" className="secondary" disabled={busy}
                onClick={() => changeLines(draft.lines.filter((entry) => entry.variantId !== line.variantId))}>
                Remove item
              </button>
            </div>
          </section>
        );
      })}
      {issue && <p role="alert">{issue}</p>}
      {notice && <p role="status">{notice}</p>}
      <footer>
        <button className="secondary" disabled={busy || saved || (!savedDraft && !draft.lines.length)}>
          {busy ? "Saving…" : "Save draft"}
        </button>
        <button type="button" className="primary" disabled={busy || !customer.consent || !saved || !draft.lines.length}
          onClick={openPreview}>Preview quotation</button>
      </footer>
      {history.length > 0 && (
        <details className="fold">
          <summary>Confirmed quotations ({history.length})</summary>
          <div className="checks">
            {history.map((quote) => (
              <button type="button" className="secondary" key={quote.id} onClick={() => {
                setOpenedQuoteId(quote.id);
                setNotice("");
                setIssue("");
              }}>
                {quote.confirmedAt.slice(0, 10)} · INR {quote.total} · {quote.id.slice(0, 8)}
              </button>
            ))}
          </div>
        </details>
      )}
    </form>
  );
}
