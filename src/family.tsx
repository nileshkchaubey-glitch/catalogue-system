import {Gallery} from "./gallery";
import {confirmAction} from "./confirm";
import {validPrice} from "./pricing";
import { useState } from "react";
import { ImagePlus, Plus } from "lucide-react";
import { english, uploadImage } from "./model";
import type { Family, Variant } from "./model";

function newVariant(unit = "Piece"): Variant {
  return {
    id: crypto.randomUUID(),
    variant: "",
    unit,
    overridePhoto: "",
    rate: "",purchase:"",
    history: [],
    ready: false,
  };
}
function PhotoField({
  value,
  label,
  choose,
  busy,
}: {
  value: string;
  label: string;
  choose: (file?: File) => void;
  busy: boolean;
}) {
  return (
    <label
      className="upload"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (!busy) choose(e.dataTransfer.files[0]);
      }}
    >
      {value ? <img src={value} alt={label} /> : <ImagePlus size={24} />}
      <b>{label}</b>
      <small>
        {value ? "Choose another photo" : "Choose or drop a product photo"}
      </small>
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={busy}
        onChange={(e) => choose(e.target.files?.[0])}
      />
    </label>
  );
}
export function FamilyForm({
  initial,
  category,
  groups:initialGroups,tree,
  selectedCollection,
  close,
  onSave,
}: {
  initial?: Family;
  tree:Record<string,string[]>;
  category: string;
  groups: string[];
  selectedCollection?: string;
  close: () => void;
  onSave: (f: Family, tree:Record<string,string[]>,groups:string[]) => Promise<void>;
}) {
  const [f, set] = useState<Family>(
    () =>
      initial ?? {
        id: crypto.randomUUID(),
        name: "",
        category,
        photo: "",gallery:[],
        collections: selectedCollection ? [selectedCollection] : [],
        variants: [newVariant()],
      },
  );
  const [departments,updateTree]=useState(tree),[groups,updateGroups]=useState(initialGroups);
  const departmentOf=(cat:string)=>Object.keys(departments).find(d=>departments[d].includes(cat))||"";
  const [adding,add]=useState<""|"Department"|"Category"|"Collection">(""),[newName,N]=useState(""),[firstCategory,K]=useState("");
  function create(){const value=newName.trim(),cat=firstCategory.trim();const safe=(x:string)=>x.length>0&&x.length<=100&&english(x)&&!["__proto__","constructor","prototype"].includes(x.toLowerCase());const exists=(a:string[],n:string)=>a.some(x=>x.toLowerCase()===n.toLowerCase());
  if(!safe(value)||(adding==="Department"&&!safe(cat)))return E("Enter an English name for each field.");
  if(adding==="Department"){if(exists(Object.keys(departments),value)||exists(Object.values(departments).flat(),cat))return E("Department and category names must be unique.");updateTree({...departments,[value]:[cat]});set({...f,category:cat})}
  if(adding==="Category"){if(exists(Object.values(departments).flat(),value))return E("This category already exists.");const dept=departmentOf(f.category);updateTree({...departments,[dept]:[...departments[dept],value]});set({...f,category:value})}
  if(adding==="Collection"){if(exists([...groups,"Full catalog"],value))return E("This collection already exists.");updateGroups([...groups,value]);set({...f,collections:[...f.collections,value]})}
  E("");add("");N("");K("")}
  const [busy, B] = useState(false),
    [error, E] = useState(""),
    [active, select] = useState(initial?.variants[0].id || f.variants[0].id);
  const v = f.variants.find((x) => x.id === active) || f.variants[0];
  function patchVariant(id: string, patch: Partial<Variant>) {
    set((old) => ({
      ...old,
      variants: old.variants.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  }
  async function upload(file: File | undefined, variantId?: string) {
    if (!file) return;
    B(true);
    E("");
    try {
      const image = await uploadImage(file);
      if (variantId) patchVariant(variantId, { overridePhoto: image });
      else set((old) => ({ ...old, photo: image }));
    } catch {
      E("Choose a readable JPG, PNG or WebP under 16 MB.");
    } finally {
      B(false);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.name.trim() || !english(f.name))
      return E("Enter a product name in English.");
    if(adding)return E("Finish adding the department, category or collection before saving.");
    const sizes = new Set<string>();
    for (const item of f.variants) {
      if(item.purchase&&!validPrice(item.purchase)){select(item.id);return E("Enter a positive purchase price with up to two decimal places.");}
      const variant = item.variant.trim().toLowerCase();
      if (
        item.rate &&
        (!/^\d{1,8}(\.\d{1,2})?$/.test(item.rate) || Number(item.rate) <= 0)
      ) {
        select(item.id);
        return E("Enter a positive rate with up to two decimal places.");
      }

      const problem = !english(item.variant)
        ? "Enter the size in English."
        : !variant && f.variants.length > 1
          ? "Give each size a name."
          : sizes.has(variant)
            ? "Each size needs a distinct name."
            : item.ready && !item.overridePhoto && !f.photo
              ? "Add a photo for the verified size."
              : "";
      if (problem) {
        select(item.id);
        return E(problem);
      }
      sizes.add(variant);
    }
    B(true);
    try {
      await onSave({
        ...f,
        name: f.name.trim(),
        variants: f.variants.map((item) => {
          const rate = item.rate ? Number(item.rate).toFixed(2) : "";
          const previous =
            initial?.variants.find((v) => v.id === item.id)?.rate || "";
          const history =
            rate === previous
              ? item.history
              : [...item.history, { at: new Date().toISOString(), rate }];
          return { ...item, purchase:item.purchase?Number(item.purchase).toFixed(2):"",variant: item.variant.trim(), rate, history };
        }),
      },departments,groups);
      close();
    } catch (e) {
      E((e as Error).message);
    } finally {
      B(false);
    }
  }
  return (
    <form noValidate onSubmit={submit} data-dirty={!initial||JSON.stringify(f)!==JSON.stringify(initial)||departments!==tree||groups!==initialGroups||!!adding} data-working={busy}>
    <small className="state-pill" role="status">{busy?"Working…":!initial||JSON.stringify(f)!==JSON.stringify(initial)||departments!==tree||groups!==initialGroups||adding?"Draft · unsaved":"Saved"}</small>
      <fieldset disabled={busy} className="fields">
        <label>
          Product name
          <input
            maxLength={100}
            value={f.name}
            onChange={(e) => set({ ...f, name: e.target.value })}
          />
        </label>
        <div className="pair">
          <label>
            Department
            <select
              value={departmentOf(f.category)}
              onChange={(e) =>
                set({ ...f, category: departments[e.target.value][0] })
              }
            >
              {Object.keys(departments).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label>
            Category
            <select
              value={f.category}
              onChange={(e) => set({ ...f, category: e.target.value })}
            >
              {departments[departmentOf(f.category)].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="pills">{(["Department","Category","Collection"] as const).map(k=><button key={k} type="button" onClick={()=>{add(k);N("");K("");E("")}}>+ {k}</button>)}</div>
        {adding&&<section className="sizebox"><label>New {adding.toLowerCase()} name<input autoFocus maxLength={100} value={newName} onChange={e=>N(e.target.value)}/></label>{adding==="Department"&&<label>First category<input maxLength={100} value={firstCategory} onChange={e=>K(e.target.value)}/></label>}<div className="pills"><button type="button" onClick={create}>Add {adding.toLowerCase()}</button><button type="button" onClick={()=>add("")}>Cancel addition</button></div></section>}
        <Gallery pictures={[f.photo,...f.gallery].filter(Boolean)} change={pictures=>set(old=>({...old,photo:pictures[0]||"",gallery:pictures.slice(1)}))} busy={busy} setBusy={B}/>
        <details className="fold">
          <summary>
            Buyer collections <small>{f.collections.length} selected</small>
          </summary>
          <div className="checks">
            {groups.map((g) => (
              <label key={g} className="check">
                <input
                  type="checkbox"
                  checked={f.collections.includes(g)}
                  onChange={(e) =>
                    set({
                      ...f,
                      collections: e.target.checked
                        ? [...f.collections, g]
                        : f.collections.filter((k) => k !== g),
                    })
                  }
                />
                {g}
              </label>
            ))}
          </div>
        </details>
        <section className="sizebox">
          <header>
            <h3>Sizes &amp; variants</h3>
            <button
              className="link"
              type="button"
              onClick={() => {
                const item = newVariant(v.unit);
                set({ ...f, variants: [...f.variants, item] });
                select(item.id);
              }}
            >
              <Plus size={15} />
              Add size
            </button>
          </header>
          {f.variants.length > 1 && (
            <div className="pills">
              {f.variants.map((item, i) => (
                <button
                  type="button"
                  aria-pressed={item.id === v.id}
                  key={item.id}
                  onClick={() => select(item.id)}
                >
                  {item.variant || "Size " + (i + 1)}
                </button>
              ))}
            </div>
          )}
          <div className="pair">
            <label>
              Size or variant
              <input
                maxLength={100}
                value={v.variant}
                placeholder="Optional for a single size"
                onChange={(e) =>
                  patchVariant(v.id, { variant: e.target.value })
                }
              />
            </label>
            <label>
              Selling unit
              <select
                value={v.unit}
                onChange={(e) => patchVariant(v.id, { unit: e.target.value })}
              >
                {["Piece", "Pack", "Box", "Carton", "Roll", "Set"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
          </div>
          <label>Purchase price per {v.unit.toLowerCase()} (INR)<input inputMode="decimal" value={v.purchase} onChange={e=>patchVariant(v.id,{purchase:e.target.value})}/></label>
          <label>
            Selling price per {v.unit.toLowerCase()} (INR) <small>Optional</small>
            <input
              inputMode="decimal"
              placeholder="Enter rate for this size"
              value={v.rate}
              onChange={(e) => patchVariant(v.id, { rate: e.target.value })}
            />
          </label>
          <details className="fold" key={v.id}>
            <summary>
              Size photo{" "}
              <small>
                {v.overridePhoto ? "Custom photo" : "Uses shared photo"}
              </small>
            </summary>
            <PhotoField
              label="Photo for this size"
              value={v.overridePhoto || f.photo}
              busy={busy}
              choose={(file) => void upload(file, v.id)}
            />
            {v.overridePhoto && (
              <button
                className="link"
                type="button"
                onClick={async () => {if(await confirmAction("Replace this size photo with the shared cover?"))patchVariant(v.id, { overridePhoto: "" })}}
              >
                Use shared photo
              </button>
            )}
          </details>
          <label className="check">
            <input
              type="checkbox"
              checked={v.ready}
              onChange={(e) => patchVariant(v.id, { ready: e.target.checked })}
            />
            I verified this size, its photo and availability for buyers.
          </label>
          <button className="link" type="button" disabled={f.variants.length===1} title="An item needs at least one variant" onClick={async()=>{if(!await confirmAction("Remove this variant and its rate history from this item when you save?"))return;const rest=f.variants.filter(x=>x.id!==v.id);set({...f,variants:rest});select(rest[0].id)}}>Remove variant</button>
        </section>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button
          type="button"
          className="secondary"
          onClick={close}
          disabled={busy}
        >
          Cancel
        </button>
        <button className="primary" disabled={busy}>
          {busy ? "Working…" : "Save product"}
        </button>
      </footer>
    </form>
  );
}
export function CollectionForm({
  families,
  groups,
  current,
  onSave,
  close,
}: {
  families: Family[];
  groups: string[];
  current?: string;
  onSave: (name: string, ids: string[]) => Promise<void>;
  close: () => void;
}) {
  const [name, N] = useState(current || ""),
    [ids, I] = useState(
      families
        .filter((f) => current && f.collections.includes(current))
        .map((f) => f.id),
    ),
    [busy, B] = useState(false),
    [err, E] = useState(""),
    [find, F] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || !english(n)) return E("Enter a collection name in English.");
    if (
      !current &&
      ["Full catalog", ...groups].some(
        (g) => g.toLowerCase() === n.toLowerCase(),
      )
    )
      return E("Choose a different collection name.");
    B(true);
    try {
      await onSave(n, ids);
      close();
    } catch (e) {
      E((e as Error).message);
    } finally {
      B(false);
    }
  }
  return (
    <form noValidate onSubmit={submit}>
      <label>
        Collection name
        <input
          maxLength={100}
          value={name}
          readOnly={!!current}
          onChange={(e) => N(e.target.value)}
        />
      </label>
      <label>
        Find products
        <input
          value={find}
          placeholder="Search by product name"
          onChange={(e) => F(e.target.value)}
        />
      </label>
      <div className="checks">
        {families
          .filter((f) => f.name.toLowerCase().includes(find.toLowerCase()))
          .map((f) => (
            <label className="check" key={f.id}>
              <input
                type="checkbox"
                checked={ids.includes(f.id)}
                onChange={(e) =>
                  I(
                    e.target.checked
                      ? [...ids, f.id]
                      : ids.filter((id) => id !== f.id),
                  )
                }
              />
              {f.name}
            </label>
          ))}
        {!families.length && (
          <small>Add products later from the product editor.</small>
        )}
      </div>
      {err && <p role="alert">{err}</p>}
      <footer>
        <button className="secondary" type="button" onClick={close}>
          Cancel
        </button>
        <button className="primary" disabled={busy}>
          Save collection
        </button>
      </footer>
    </form>
  );
}
