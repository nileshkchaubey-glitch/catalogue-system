import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { applyBulkMarkup, buildBulkPreview } from "../shared/quote-pricing.mjs";
import type { BulkPreview } from "../shared/quote-pricing.mjs";
import { money, variantsOf } from "./model";
import type { Workspace } from "./model";

export function BulkPricingForm({ workspace, variantIds, save, close }: {
  workspace: Workspace;
  variantIds?: string[];
  save: (workspace: Workspace, message: string) => Promise<void | boolean>;
  close: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [percent, setPercent] = useState("");
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState("");
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const markupInput = useRef<HTMLInputElement>(null);
  const returningToSelection = useRef(false);
  const candidateIds = variantIds && new Set(variantIds);
  const candidates = workspace.families.flatMap(variantsOf).filter((product) => !candidateIds || candidateIds.has(product.id));
  const selectedIds = new Set(selected);
  const changeCount = preview?.rows.filter((row) => row.status === "change").length ?? 0;

  useEffect(() => {
    if (preview) {
      previewHeading.current?.focus();
    } else if (returningToSelection.current) {
      markupInput.current?.focus();
      returningToSelection.current = false;
    }
  }, [preview]);

  function reviewMarkup(event: FormEvent) {
    event.preventDefault();
    setIssue("");
    try {
      setPreview(buildBulkPreview(workspace, selected, percent));
    } catch (error) {
      setIssue((error as Error).message);
    }
  }

  async function confirmMarkup(event: FormEvent) {
    event.preventDefault();
    if (!preview || busy) return;
    setBusy(true);
    setIssue("");
    try {
      const next = applyBulkMarkup(workspace, preview, new Date().toISOString());
      if (await save(next, `${changeCount} selling ${changeCount === 1 ? "rate" : "rates"} updated.`) !== false) close();
    } catch (error) {
      setIssue((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (preview) return (
    <form onSubmit={confirmMarkup}>
      <h3 ref={previewHeading} tabIndex={-1}>Preview {preview.percent}% markup</h3>
      <p>{changeCount} of {preview.rows.length} selected rates will change.</p>
      <div className="checks">
        {preview.rows.map((row) => (
          <div className="sizebox" key={row.id}>
            <strong>{[row.name, row.variant].filter(Boolean).join(" · ")}</strong>
            {row.status === "missing-cost" && <small>Skipped. Enter a purchase cost to calculate a rate.</small>}
            {row.status === "out-of-range" && <small>Skipped. The calculated rate exceeds the supported range.</small>}
            {row.status === "unchanged" && <small>{money(row.before)} · Unchanged</small>}
            {row.status === "change" && (
              <small>Purchase cost {money(row.purchase)} · Selling rate {money(row.before)} → {money(row.after)}</small>
            )}
          </div>
        ))}
      </div>
      {issue && <p role="alert">{issue}</p>}
      <footer>
        <button type="button" className="secondary" disabled={busy} onClick={() => {
          returningToSelection.current = true;
          setPreview(null);
          setIssue("");
        }}>Back</button>
        <button className="primary" disabled={busy || !changeCount}>
          {busy ? "Saving…" : "Confirm markup"}
        </button>
      </footer>
    </form>
  );

  return (
    <form onSubmit={reviewMarkup} noValidate>
      <label>
        Markup on purchase cost (%)
        <input ref={markupInput} inputMode="decimal" maxLength={8} value={percent} onChange={(event) => setPercent(event.target.value)} />
      </label>
      <div className="card-actions">
        <button type="button" className="secondary" disabled={!candidates.length} onClick={() => setSelected(candidates.map(({ id }) => id))}>
          Select all listed items
        </button>
        <button type="button" className="secondary" disabled={!selected.length} onClick={() => setSelected([])}>Clear selection</button>
      </div>
      {candidates.length ? (
        <div className="checks" role="group" aria-label="Items to mark up">
          {candidates.map((product) => (
            <label className="check" key={product.id}>
              <input type="checkbox" checked={selectedIds.has(product.id)} onChange={(event) => {
                const checked = event.target.checked;
                setSelected((ids) => checked ? [...ids, product.id] : ids.filter((id) => id !== product.id));
              }} />
              <span>
                {[product.name, product.variant, product.unit].filter(Boolean).join(" · ")}
                <br />
                <small>{product.purchase ? `Purchase cost ${money(product.purchase)}` : "Purchase cost pending"}</small>
              </span>
            </label>
          ))}
        </div>
      ) : <p>No items match this selection.</p>}
      {issue && <p role="alert">{issue}</p>}
      <footer>
        <button type="button" className="secondary" onClick={close}>Cancel</button>
        <button className="primary" disabled={!selected.length}>Preview markup</button>
      </footer>
    </form>
  );
}
