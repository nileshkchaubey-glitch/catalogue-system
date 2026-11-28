import { useRef, useState } from "react";
import type { Ref } from "react";
import { Gallery } from "../../gallery";
import { confirmAction } from "../../confirm";
import { departmentNames, departmentOf } from "../../model";
import type { Workspace } from "../../model";
import { duplicateEntry, newEntry, newRow, parseVariantPaste, prepareNewProduct, sellingUnits } from "./entry";
import type { EntryRow, ProductEntry, SellingUnit } from "./entry";

export function FastEntryForm({ formRef, workspace, profileId, initialCategory, initialCollection, onSave, close }: {
  formRef: Ref<HTMLFormElement>; workspace: Workspace; profileId: string; initialCategory: string;
  initialCollection?: string; onSave: (workspace: Workspace, message: string) => Promise<void>; close: () => void;
}) {
  const [draft, setDraft] = useState(() => newEntry(initialCategory, initialCollection ? [initialCollection] : []));
  const [unit, setUnit] = useState<SellingUnit>("Piece");
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState(""), [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false), [paste, setPaste] = useState("");
  const [source, setSource] = useState(""), [reuse, setReuse] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const patch = (next: Partial<ProductEntry>) => { setDraft(old => ({ ...old, ...next })); setDirty(true); setIssue(""); };
  const rowPatch = (id: string, next: Partial<EntryRow>) => {
    setDraft(old => ({ ...old, rows: old.rows.map(r => r.id === id ? { ...r, ...next } : r) }));
    setDirty(true); setIssue("");
  };
  async function save(next: boolean) {
    if (busy || saving.current) return;
    setIssue(""); setNotice("");
    if (paste.trim()) { setIssue("Apply or clear the pasted rows before saving."); return; }
    saving.current = true; setBusy(true);
    try {
      await onSave(prepareNewProduct(workspace, draft, new Date().toISOString()), "Product saved as draft.");
      if (!next) { close(); return; }
      setDraft(newEntry(draft.category, draft.collections, unit));
      setPaste(""); setSource(""); setReuse(false); setDirty(false);
      setNotice("Saved. Enter the next product.");
      requestAnimationFrame(() => nameRef.current?.focus());
    } catch (error) { setIssue(error instanceof Error ? error.message : "Could not save product."); }
    finally { saving.current = false; setBusy(false); }
  }
  async function copy() {
    const family = workspace.families.find(f => f.id === source);
    if (!family || busy) return;
    if ((dirty || paste.trim()) && !await confirmAction("Replace the current entry with a product template?")) return;
    const copy = duplicateEntry(family, reuse);
    setDraft(copy); setUnit(copy.rows[0]?.unit ?? "Piece"); setPaste(""); setDirty(true); setIssue("");
    nameRef.current?.focus();
  }
  async function applyPaste() {
    try {
      const rows = parseVariantPaste(paste, unit);
      if (draft.rows.some(r => r.variant || r.purchase || r.rate) && !await confirmAction("Replace the current variant rows with the pasted rows?")) return;
      patch({ rows }); setPaste("");
    } catch (error) { setIssue(error instanceof Error ? error.message : "Invalid paste."); }
  }
  const department = departmentOf(workspace.departments, draft.category);
  return <form ref={formRef} noValidate data-dirty={dirty || !!paste.trim()} data-working={busy}
    onSubmit={e => { e.preventDefault(); void save(false); }}
    onKeyDown={e => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.repeat || document.querySelector("dialog[data-confirm][open]")) return;
      if (e.key.toLowerCase() === "s" || e.key === "Enter") { e.preventDefault(); void save(e.key === "Enter"); }
    }}>
    <p className="muted">Enter all sizes together. New items remain private drafts until verified in the product editor.</p>
    <small className="state-pill" role="status">{busy ? "Working…" : dirty || paste.trim() ? "Unsaved changes" : "New entry"}</small>
    <fieldset disabled={busy} className="fields">
      <details className="fold"><summary>Duplicate a product template</summary>
        <label>Existing product<select value={source} onChange={e => setSource(e.target.value)}>
          <option value="">Choose product</option>{workspace.families.map(f => <option key={f.id} value={f.id}>{f.name} · {f.category}</option>)}
        </select></label>
        <label className="check"><input type="checkbox" checked={reuse} onChange={e => setReuse(e.target.checked)} />Reuse shared photos (verify before publishing)</label>
        <button type="button" className="secondary" disabled={!source} onClick={() => void copy()}>Copy as new draft</button>
        <small>Prices, variant photos, readiness and history are never copied.</small>
      </details>
      <label>Product name<input ref={nameRef} autoFocus maxLength={100} value={draft.name} onChange={e => patch({ name: e.target.value })} /></label>
      <div className="pair">
        <label>Department<select value={department} onChange={e => patch({ category: workspace.departments[e.target.value][0] })}>
          {departmentNames(workspace.departments, workspace.departmentOrder).map(d => <option key={d}>{d}</option>)}</select></label>
        <label>Category<select value={draft.category} onChange={e => patch({ category: e.target.value })}>
          {(workspace.departments[department] ?? []).map(c => <option key={c}>{c}</option>)}</select></label>
      </div>
      <details className="fold"><summary>Collections ({draft.collections.length})</summary>
        {workspace.collections.map(c => <label className="check" key={c}><input type="checkbox" checked={draft.collections.includes(c)}
          onChange={e => patch({ collections: e.target.checked ? [...draft.collections,c] : draft.collections.filter(x => x !== c) })}/>{c}</label>)}
      </details>
      <details className="fold"><summary>Shared images ({[draft.photo,...draft.gallery].filter(Boolean).length})</summary>
        <Gallery profileId={profileId} pictures={[draft.photo,...draft.gallery].filter(Boolean)}
          change={([photo="",...gallery]) => patch({ photo,gallery })} busy={busy} setBusy={setBusy}/>
      </details>
      <section className="sizebox">
        <h3>Variant grid</h3>
        <label>Default selling unit<select value={unit} onChange={e => {
          const selected = e.target.value as SellingUnit;
          setUnit(selected);
          if (draft.rows.length === 1 && !draft.rows[0].variant && !draft.rows[0].purchase && !draft.rows[0].rate)
            rowPatch(draft.rows[0].id, {unit:selected});
        }}>{sellingUnits.map(u => <option key={u}>{u}</option>)}</select></label>
        <div className="fast-entry-grid" role="group" aria-label="Variant rows">
          {draft.rows.map((r,i) => <div className="fast-entry-row" key={r.id}>
            <label>Size {i+1}<input maxLength={100} value={r.variant} onChange={e => rowPatch(r.id,{variant:e.target.value})}/></label>
            <label>Unit<select value={r.unit} onChange={e => rowPatch(r.id,{unit:e.target.value as SellingUnit})}>{sellingUnits.map(u => <option key={u}>{u}</option>)}</select></label>
            <label>Cost (INR)<input inputMode="decimal" value={r.purchase} onChange={e => rowPatch(r.id,{purchase:e.target.value})}/></label>
            <label>Rate (INR)<input inputMode="decimal" value={r.rate} onChange={e => rowPatch(r.id,{rate:e.target.value})}/></label>
            <button type="button" className="link" disabled={draft.rows.length===1} aria-label={"Remove variant "+(i+1)} onClick={async () => { if (await confirmAction("Remove this draft variant?")) patch({ rows:draft.rows.filter(x=>x.id!==r.id) }); }}>Remove</button>
          </div>)}
        </div>
        <button type="button" className="secondary" disabled={draft.rows.length>=200} onClick={() => patch({ rows:[...draft.rows,newRow(unit)] })}>Add size</button>
        <details className="fold"><summary>Paste variant rows from Excel</summary>
          <label>Size, Unit, Purchase, Selling (tab-separated)<textarea rows={4} value={paste} onChange={e => setPaste(e.target.value)} /></label>
          <button type="button" className="secondary" disabled={!paste.trim()} onClick={() => void applyPaste()}>Apply pasted rows</button>
        </details>
      </section>
    </fieldset>
    {issue && <p role="alert">{issue}</p>}{notice && <p role="status">{notice}</p>}
    <footer><button type="button" className="secondary" disabled={busy} onClick={() => { if (!dirty && !paste.trim()) close(); else void confirmAction("Discard unsaved product entry?").then(ok=>{if(ok)close();}); }}>Cancel</button>
      <button type="submit" className="secondary" disabled={busy}>Save Draft</button>
      <button type="button" className="primary" disabled={busy} onClick={() => void save(true)}>{busy?"Working…":"Save & Next"}</button></footer>
  </form>;
}
