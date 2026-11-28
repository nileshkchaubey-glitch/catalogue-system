import { Gallery } from "./gallery";
import { confirmAction } from "./confirm";
import { prepareFamily } from "./editor";
import { markedUp, normalizeRate } from "./pricing";
import { useState } from "react";
import type { Ref } from "react";
import { ImagePlus, Plus } from "lucide-react";
import { departmentOf, english, fullCatalog, money, uploadImage } from "./model";
import type { Family, Variant, Workspace } from "./model";

function newVariant(unit = "Piece"): Variant {
  return {
    id: crypto.randomUUID(),
    variant: "",
    unit,
    overridePhoto: "",
    rate: "",
    purchase: "",
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
        onChange={(e) => {
          choose(e.currentTarget.files?.[0]);
          e.currentTarget.value = "";
        }}
      />
    </label>
  );
}
export function FamilyForm({
  formRef,
  initial,
  category,
  groups: initialGroups,
  tree,
  selectedCollection,
  profileId,
  cancel,
  onSave,
}: {
  formRef: Ref<HTMLFormElement>;
  initial?: Family;
  tree: Workspace["departments"];
  category: string;
  groups: string[];
  selectedCollection?: string;
  profileId: string;
  cancel: () => void;
  onSave: (f: Family, tree: Workspace["departments"], groups: string[]) => Promise<void>;
}) {
  const [original] = useState(() => ({ family: initial, tree, groups: initialGroups }));
  const [f, set] = useState<Family>(
    () =>
      initial ?? {
        id: crypto.randomUUID(),
        name: "",
        category,
        photo: "",
        gallery: [],
        collections: selectedCollection ? [selectedCollection] : [],
        variants: [newVariant()],
      },
  );
  const [departments, updateTree] = useState(tree),
    [groups, updateGroups] = useState(initialGroups);
  const [adding, add] = useState<"" | "Department" | "Category" | "Collection">(""),
    [newName, N] = useState(""),
    [firstCategory, K] = useState("");
  const [busy, B] = useState(false),
    [error, E] = useState(""),
    [active, select] = useState(f.variants[0].id),
    [markup, setMarkup] = useState("");
  const v = f.variants.find((x) => x.id === active) || f.variants[0];
  const department = departmentOf(departments, f.category);
  const suggestedRate = markedUp(v.purchase, markup);
  const dirty = departments !== original.tree || groups !== original.groups ||
    (!!adding && !!(newName || firstCategory)) ||
    JSON.stringify(f) !== JSON.stringify(original.family);

  function create() {
    const value = newName.trim(), category = firstCategory.trim();
    const safe = (text: string) => text.length > 0 && text.length <= 100 &&
      english(text) && !["__proto__", "constructor", "prototype"].includes(text.toLowerCase());
    const exists = (items: string[], name: string) =>
      items.some((item) => item.toLowerCase() === name.toLowerCase());
    const categories = Object.values(departments).flat();
    if (!safe(value) || (adding === "Department" && !safe(category)))
      return E("Enter an English name for each field.");
    if (adding === "Department") {
      if (exists(Object.keys(departments), value) || exists(categories, category))
        return E("Department and category names must be unique.");
      updateTree({ ...departments, [value]: [category] });
      set({ ...f, category });
    } else if (adding === "Category") {
      if (!department) return E("Choose a department first.");
      if (exists(categories, value)) return E("This category already exists.");
      updateTree({ ...departments, [department]: [...departments[department], value] });
      set({ ...f, category: value });
    } else if (adding === "Collection") {
      if (exists([...groups, fullCatalog], value)) return E("This collection already exists.");
      updateGroups([...groups, value]);
      set({ ...f, collections: [...f.collections, value] });
    }
    E("");
    add("");
    N("");
    K("");
  }
  function patchVariant(id: string, patch: Partial<Variant>) {
    set((old) => ({
      ...old,
      variants: old.variants.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  }
  async function upload(file: File | undefined, variantId: string) {
    if (!file || busy) return;
    B(true);
    E("");
    try {
      patchVariant(variantId, { overridePhoto: await uploadImage(file, profileId) });
    } catch (e) {
      E((e as Error).message);
    } finally {
      B(false);
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (adding) return E("Finish adding the department, category or collection before saving.");
    if (!department) return E("Choose a department and category.");
    const result = prepareFamily(f, original.family, new Date().toISOString());
    if ("error" in result) {
      if (result.variantId) select(result.variantId);
      return E(result.error);
    }
    E("");
    B(true);
    try {
      await onSave(result.family, departments, groups);
    } catch (e) {
      E((e as Error).message);
    } finally {
      B(false);
    }
  }
  return (
    <form ref={formRef} noValidate onSubmit={submit} data-dirty={dirty} data-working={busy}
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "s") return;
        event.preventDefault();
        if (event.repeat || busy || document.querySelector("dialog[data-confirm][open]")) return;
        event.currentTarget.requestSubmit();
      }}>
      <small className="state-pill" role="status">{busy ? "Working…" : dirty ? "Unsaved changes" : "Saved"}</small>
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
              value={department}
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
              {(departments[department] ?? []).map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="pills">
          {(["Department", "Category", "Collection"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => {
                add(kind);
                N("");
                K("");
                E("");
              }}
            >
              + {kind}
            </button>
          ))}
        </div>
        {adding && (
          <section className="sizebox">
            <label>
              New {adding.toLowerCase()} name
              <input autoFocus maxLength={100} value={newName} onChange={(e) => N(e.target.value)} />
            </label>
            {adding === "Department" && (
              <label>
                First category
                <input maxLength={100} value={firstCategory} onChange={(e) => K(e.target.value)} />
              </label>
            )}
            <div className="pills">
              <button type="button" onClick={create}>Add {adding.toLowerCase()}</button>
              <button type="button" onClick={() => add("")}>Cancel addition</button>
            </div>
          </section>
        )}
        <Gallery
          profileId={profileId}
          pictures={[f.photo, ...f.gallery].filter(Boolean)}
          change={([photo = "", ...gallery]) => set((old) => ({ ...old, photo, gallery }))}
          busy={busy}
          setBusy={B}
        />
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
          <label>
            Purchase price per {v.unit.toLowerCase()} (INR) <small>Internal</small>
            <input
              inputMode="decimal"
              value={v.purchase}
              onChange={(e) => patchVariant(v.id, { purchase: e.target.value })}
            />
          </label>
          <label>
            Selling price per {v.unit.toLowerCase()} (INR) <small>Optional</small>
            <input
              inputMode="decimal"
              placeholder="Enter rate for this size"
              value={v.rate}
              onChange={(e) => patchVariant(v.id, { rate: e.target.value })}
            />
          </label>
          <details className="fold">
            <summary>Calculate selling price</summary>
            <label>
              Markup on purchase price (%)
              <input inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)} />
            </label>
            <button
              type="button"
              className="secondary"
              disabled={!suggestedRate}
              onClick={() => patchVariant(v.id, { rate: normalizeRate(suggestedRate, v.rate) })}
            >
              {suggestedRate ? `Use ${money(suggestedRate)} as selling price` : "Use calculated selling price"}
            </button>
          </details>
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
                onClick={async () => {
                  if (await confirmAction("Replace this size photo with the shared cover?"))
                    patchVariant(v.id, { overridePhoto: "" });
                }}
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
          <button
            className="link"
            type="button"
            disabled={f.variants.length === 1}
            title={f.variants.length === 1 ? "An item needs at least one variant" : undefined}
            onClick={async () => {
              if (!(await confirmAction("Remove this variant and its rate history from this item when you save?"))) return;
              const variants = f.variants.filter((item) => item.id !== v.id);
              set({ ...f, variants });
              select(variants[0].id);
            }}
          >
            Remove variant
          </button>
        </section>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button
          type="button"
          className="secondary"
          onClick={cancel}
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
