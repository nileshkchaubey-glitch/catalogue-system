import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  LibraryBig,
  Tags,
  Users,
  Send,
  Plus,
  ChevronRight,
  Eye,
  Search,
  FolderOpen,
  LockKeyhole,
  BookOpen,
  UserPlus,
  LayoutGrid,
  List,
  ArrowLeft,
  Pencil,
  Package,
  RefreshCw,
  ShoppingBasket,
  Sheet,
} from "lucide-react";
import {
  departmentOf,
  departmentNames,
  variantsOf,
  fullCatalog,
  featuredCollection,
  empty,
  money,
  buyerLink,
} from "./model";
import type { Product, Customer, Workspace, Family } from "./model";
import { Hero, Dialog, CategoryIcon } from "./ui";
import { CustomerForm, RateForm } from "./forms";
import { FamilyForm, CollectionForm } from "./family";
import { Snapshot } from "./snapshot";
import { confirmAction } from "./confirm";
import { SessionBoundary } from "./session";
import type { OwnerProfile } from "./session";
import { QuotationForm } from "./quotations";
import { BulkPricingForm } from "./bulk-pricing";
import { CatalogueExcelDialog } from "./catalogue-excel-dialog";
import { FastEntryForm } from "./features/product-entry/FastEntryForm";
import "./style.css";
type Modal =
  | { kind: "product"; family?: Family }
  | { kind: "collection"; current?: string }
  | { kind: "snapshot"; id?: string }
  | { kind: "customer"; c?: Customer }
  | { kind: "rate"; p: Product }
  | { kind: "draft"; customerId: string }
  | { kind: "bulk"; variantIds: string[] }
  | { kind: "excel" }
  | { kind: "fast-entry" };
const navigation = [
  { name: "Products", Icon: LibraryBig },
  { name: "Rates", Icon: Tags },
  { name: "Customers", Icon: Users },
] as const;
function Notice({ children }: { children: React.ReactNode }) {
  return <div className="notice">{children}</div>;
}
function SearchBox({
  value,
  set,
  placeholder,
}: {
  value: string;
  set: (s: string) => void;
  placeholder: string;
}) {
  return (
    <div className="search">
      <Search size={16} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </div>
  );
}
function App({ profile, signOut, checkSession }: {
  profile: OwnerProfile;
  signOut: () => Promise<void>;
  checkSession: () => Promise<void>;
}) {
  const [tab, T] = useState("Products"),
    [filter, F] = useState(""),
    [query, Q] = useState(""),
    [listMode, M] = useState(false),
    [modal, D] = useState<Modal | null>(null);
  const [data, S] = useState<Workspace>(empty),
    [revision, R] = useState(""),
    [issue, E] = useState(""),
    [status, A] = useState(""),
    [selected, C] = useState("");
  const [scope, setScope] = useState<"department" | "category" | "collection">(
    "department",
  );
  const allGroups = [fullCatalog, ...data.collections];
  const { departments } = data;
  const orderedDepartments = departmentNames(departments, data.departmentOrder);
  const productForm = useRef<HTMLFormElement>(null);
  const products = data.families.flatMap(variantsOf);
  const version = useRef("");
  const formRevision = useRef("");
  const writes = useRef(false);
  const generation = useRef(0);
  async function refresh() {
    if (writes.current) return;
    const ticket = ++generation.current;
    try {
      const r = await fetch("/api/workspace", {
        cache: "no-store",
        headers: { "X-Owner-Profile": profile.id },
      });
      if (r.status === 401 || r.status === 403) {
        await checkSession();
        throw Error();
      }
      if (!r.ok) throw Error();
      const next = await r.json();
      if (ticket !== generation.current || writes.current) return;
      version.current = r.headers.get("X-Revision") || "";
      R(version.current);
      S(next);
      E("");
    } catch {
      if (ticket === generation.current)
        E("Could not load the workspace. Check your connection and refresh.");
    }
  }
  useEffect(() => {
    void refresh();
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    const timer = setInterval(focus, 20000);
    return () => {
      window.removeEventListener("focus", focus);
      clearInterval(timer);
    };
  }, [profile.id, checkSession]);
  useEffect(() => {
    if (status) {
      const id = setTimeout(() => A(""), 3800);
      return () => clearTimeout(id);
    }
  }, [status]);
  function open(m: Modal) {
    formRevision.current = version.current;
    D(m);
  }
  async function closeDialog() {
    const form = productForm.current;
    if (writes.current || form?.dataset.working === "true") return;
    if (
      form?.dataset.dirty === "true" &&
      !(await confirmAction("Discard unsaved product changes?"))
    ) return;
    D(null);
  }
  async function save(next: Workspace, msg: string) {
    if (writes.current) throw Error("A save is already in progress.");
    if (formRevision.current !== version.current)
      throw Error(
        "The workspace changed. Close this form and reopen it to review the latest data.",
      );
    writes.current = true;
    generation.current++;
    try {
      const r = await fetch("/api/workspace", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Owner-Profile": profile.id,
          "X-Revision": formRevision.current,
        },
        body: JSON.stringify(next),
      });
      const result = await r.json();
      if (r.status === 401 || r.status === 403) await checkSession();
      if (!r.ok) throw Error(result.error || "Could not save changes.");
      S(result.workspace);
      version.current = result.revision;
      formRevision.current = result.revision;
      R(result.revision);
      A(msg);
    } finally {
      writes.current = false;
    }
  }
  const navigate = (t: string) => {
    T(t);
    Q("");
    F("");
    window.scrollTo(0, 0);
  };
  const viewFilter = (v: string, kind: typeof scope = "collection") => {
    setScope(kind);
    T("Products");
    F(v);
    Q("");
  };
  const chosen = data.customers.find((c) => c.id === selected);
  function choose(c?: Customer) {
    C(c?.id || "");
  }
  function draft(c: Customer) {
    open({ kind: "draft", customerId: c.id });
  }
  const productDepartment = (category: string) => departmentOf(departments, category);
  const matches = (s: string) =>
    s.toLowerCase().includes(query.toLowerCase().trim());
  const isLibrary = tab === "Products" && !filter;
  const isDepartment = tab === "Products" && scope === "department" && !!filter;
  const filtered = products.filter(
    (p) =>
      (!filter ||
        (scope === "collection"
          ? p.collections.includes(filter)
          : scope === "department"
            ? productDepartment(p.category) === filter
            : p.category === filter)) &&
      matches(
        [p.name, p.variant, p.category, productDepartment(p.category)].join(" "),
      ),
  );
  const displayProducts =
    tab === "Rates"
      ? filtered
      : filtered.filter(
          (p, i, rows) =>
            rows.findIndex((x) => x.familyId === p.familyId) === i,
        );
  const folderNames = isLibrary
    ? orderedDepartments
    : isDepartment
      ? departments[filter] ?? []
      : [];
  const folders = folderNames.filter(
    (key) =>
      matches(key) ||
      (isLibrary && departments[key].some((cat) => matches(cat))),
  );
  function emptyPanel(text: string, btn: string, action: () => void) {
    return (
      <div className="empty">
        <FolderOpen size={32} />
        <h3>{text}</h3>
        <button className="secondary" onClick={action}>
          {btn}
        </button>
      </div>
    );
  }
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <img src="/logo.png" alt="XL Traders" />
          <b>Catalog Studio</b>
        </div>
        <span className="rail-label">WORKSPACE</span>
        <nav>
          {navigation.map(({ name, Icon }) => (
            <button
              key={name}
              aria-current={tab === name ? "page" : undefined}
              className={tab === name ? "active" : ""}
              onClick={() => navigate(name)}
            >
              <Icon size={19} />
              {name}
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <span className="private-icon">
            <LockKeyhole size={17} />
          </span>
          <div>
            <b>Private preview</b>
            <small>{profile.business_name}</small>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="top">
          <span>
            Workspace <ChevronRight size={14} /> <b>{tab}</b>
          </span>
          <div className="top-actions">
            <a className="secondary" href={buyerLink("Full catalog")}>
              <Eye size={17} /> Buyer preview
            </a>
            <button type="button" className="secondary" onClick={() => void signOut()}>Sign out</button>
          </div>
        </header>
        <main>
          <div className="heading">
            <div>
              {filter && tab === "Products" && (
                <button
                  className="back"
                  onClick={() =>
                    scope === "category"
                      ? viewFilter(productDepartment(filter), "department")
                      : viewFilter("")
                  }
                >
                  <ArrowLeft size={14} />{" "}
                  {scope === "category"
                    ? productDepartment(filter) || "Product library"
                    : "Product library"}
                </button>
              )}
              <h1>
                {tab === "Products"
                  ? filter || "Product library"
                  : tab === "Rates"
                    ? "Product rates"
                    : "Customers"}
              </h1>
              <p>
                {isLibrary
                  ? "Organize your products and share the right collection with each buyer."
                  : tab === "Rates"
                    ? "Manage internal selling rates by product and unit."
                    : tab === "Customers"
                      ? "Manage contacts, permissions and preferred collections."
                      : "Manage the products in this selection."}
              </p>
            </div>
            {filter && scope === "collection" && tab === "Products" && (
              <button
                className="secondary"
                onClick={() => open({ kind: "collection", current: filter })}
              >
                Manage products
              </button>
            )}
            {tab === "Products" && (
              <button className="secondary" disabled={!revision} onClick={() => open({ kind: "excel" })}>
                <Sheet size={17} aria-hidden /> Catalogue Excel
              </button>
            )}
            {tab === "Products" && (
              <button className="secondary" disabled={!revision} onClick={() => open({ kind: "fast-entry" })}>Fast Entry</button>
            )}
            {tab === "Rates" ? (
              <button
                className="primary"
                disabled={!revision || !filtered.length}
                onClick={() => open({ kind: "bulk", variantIds: filtered.map((p) => p.id) })}
              >
                <Tags size={17} /> Bulk markup
              </button>
            ) : (
              <button
                className="primary"
                disabled={!revision}
                onClick={() =>
                  open(
                    tab === "Customers"
                      ? { kind: "customer" }
                      : { kind: "product" },
                  )
                }
              >
                <Plus size={18} />
                {tab === "Customers" ? "Add customer" : "Add product"}
              </button>
            )}
          </div>
          {issue && (
            <Notice>
              {issue}{" "}
              <button className="link" onClick={() => void refresh()}>
                Refresh
              </button>
            </Notice>
          )}
          {isLibrary && data.collections.includes(featuredCollection) && (
            <Hero open={() => viewFilter(featuredCollection)} />
          )}
          <div className={isLibrary ? "columns" : "onecol"}>
            <section className="panel">
              <header className="panelhead">
                <div>
                  <h2>
                    {isLibrary
                      ? "Departments"
                      : isDepartment
                        ? "Categories"
                        : tab === "Products"
                          ? "Products"
                          : tab === "Rates"
                            ? "Rate list"
                            : "Customer directory"}
                  </h2>
                  <small>
                    {isLibrary
                      ? `${Object.keys(departments).length} departments · ${data.families.length} products`
                      : tab === "Customers"
                        ? `${data.customers.length} contacts`
                        : tab === "Rates"
                          ? `${filtered.length} variants`
                          : `${displayProducts.length} products`}
                  </small>
                </div>
                {isLibrary && (
                  <div className="toggle">
                    <button
                      aria-label="Row view"
                      aria-pressed={!listMode}
                      className={!listMode ? "on" : ""}
                      onClick={() => M(false)}
                    >
                      <List size={17} />
                    </button>
                    <button
                      aria-label="Grid view"
                      aria-pressed={listMode}
                      className={listMode ? "on" : ""}
                      onClick={() => M(true)}
                    >
                      <LayoutGrid size={16} />
                    </button>
                  </div>
                )}
              </header>
              <div className="searchpad">
                <SearchBox
                  value={query}
                  set={Q}
                  placeholder={
                    tab === "Customers"
                      ? "Search by name or number"
                      : isLibrary
                        ? "Find a category or product"
                        : "Search products"
                  }
                />
              </div>
              {(isLibrary || isDepartment) && (
                <div className={"folders " + (listMode ? "grid" : "")}>
                  {folders.map((c) => (
                    <button
                      className="folder"
                      key={c}
                      onClick={() =>
                        viewFilter(c, isLibrary ? "department" : "category")
                      }
                    >
                      <CategoryIcon
                        category={isLibrary ? departments[c][0] : c}
                      />
                      <div className="grow">
                        <b>{c}</b>
                        {isLibrary && (
                          <small>{departments[c].join(" · ")}</small>
                        )}
                      </div>
                      <small>
                        {isLibrary
                          ? departments[c].length + " categories"
                          : data.families.filter((f) => f.category === c)
                              .length + " products"}
                      </small>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </div>
              )}
              {tab !== "Customers" &&
                ((!isLibrary && !isDepartment) || query.trim()) && (
                  <div className="rows">
                    {displayProducts.map((p) => (
                      <div className="row" key={p.id}>
                        {p.photo ? (
                          <img className="thumb" src={p.photo} alt="" />
                        ) : (
                          <CategoryIcon category={p.category} />
                        )}
                        <div className="grow">
                          <b>{p.name}</b>
                          <small>
                            {tab === "Rates"
                              ? [
                                  p.variant,
                                  p.unit,
                                  p.ready ? "Verified" : "Draft",
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : p.category +
                                " · " +
                                data.families.find((f) => f.id === p.familyId)!
                                  .variants.length +
                                " size(s)"}
                          </small>
                        </div>
                        {tab === "Rates" && (
                          <span className="rate">{money(p.rate)}</span>
                        )}
                        {tab === "Rates" && p.ready && p.rate && (
                          <button
                            className="secondary"
                            onClick={() => open({ kind: "snapshot", id: p.id })}
                          >
                            <Send size={15} /> Snapshot
                          </button>
                        )}
                        <button
                          className="iconbtn"
                          aria-label={"Edit " + p.name}
                          onClick={() =>
                            open(
                              tab === "Rates"
                                ? { kind: "rate", p }
                                : {
                                    kind: "product",
                                    family: data.families.find(
                                      (f) => f.id === p.familyId,
                                    ),
                                  },
                            )
                          }
                        >
                          <Pencil size={16} />
                        </button>
                      </div>
                    ))}
                    {filtered.length === 0 &&
                      (!(isLibrary || isDepartment) || !folders.length) &&
                      (query ? (
                        <p className="quiet">No results match this search.</p>
                      ) : (
                        emptyPanel("No products here yet", "Add product", () =>
                          open({ kind: "product" }),
                        )
                      ))}
                  </div>
                )}
              {tab === "Customers" && (
                <div className="rows">
                  {data.customers
                    .filter((c) => matches(c.name + " " + c.phone))
                    .map((c) => (
                      <div className="row" key={c.id}>
                        <span className="tileicon blue">
                          <Users size={19} />
                        </span>
                        <div className="grow">
                          <b>{c.name}</b>
                          <small>
                            +{c.phone} · {c.collection}
                          </small>
                        </div>
                        <button
                          className="iconbtn"
                          aria-label={"Edit " + c.name}
                          onClick={() => open({ kind: "customer", c })}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="secondary"
                          onClick={() => draft(c)}
                        >
                          <Send size={15} /> Quotation
                        </button>
                      </div>
                    ))}
                  {!data.customers.length
                    ? emptyPanel(
                        "Add your first customer",
                        "Add customer",
                        () => open({ kind: "customer" }),
                      )
                    : !data.customers.some((c) =>
                        matches(c.name + " " + c.phone),
                      ) && <p className="quiet">No matching contacts.</p>}
                </div>
              )}
            </section>
            {isLibrary && (
              <aside className="right">
                <section className="panel quick">
                  <span className="actionicon">
                    <Send size={21} />
                  </span>
                  <h2>Prepare a quotation</h2>
                  <label>
                    Customer
                    <select
                      value={selected}
                      onChange={(e) =>
                        choose(
                          data.customers.find((c) => c.id === e.target.value),
                        )
                      }
                    >
                      <option value="">Select a customer</option>
                      {data.customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="link"
                    onClick={() => open({ kind: "customer" })}
                  >
                    <UserPlus size={15} /> Add customer
                  </button>
                  <button className="primary wide" disabled={!chosen} onClick={() => chosen && draft(chosen)}>
                    <Send size={17} /> Open quotation
                  </button>
                  <button
                    className="secondary wide"
                    onClick={() => open({ kind: "snapshot" })}
                  >
                    <Package size={16} /> Product snapshot
                  </button>
                </section>
                <section className="panel shortlist">
                  <h3>
                    <BookOpen size={17} /> Buyer collections
                  </h3>
                  {data.collections.map((k) => (
                    <button key={k} onClick={() => viewFilter(k)}>
                      {k}
                      <ChevronRight size={15} />
                    </button>
                  ))}
                  <button
                    className="link"
                    disabled={!revision}
                    onClick={() => open({ kind: "collection" })}
                  >
                    <Plus size={16} /> Create collection
                  </button>
                </section>
              </aside>
            )}
          </div>
        </main>
      </div>
      {status && (
        <div role="status" className="toast">
          {status}
        </div>
      )}
      {modal && (
        <Dialog
          title={
            modal.kind === "product"
              ? modal.family
                ? "Edit product"
                : "Add product"
              : modal.kind === "customer"
                ? modal.c
                  ? "Edit customer"
                  : "Add customer"
                : modal.kind === "rate"
                  ? "Update rate"
                  : modal.kind === "snapshot"
                    ? "Product snapshot"
                    : modal.kind === "collection"
                      ? modal.current
                        ? "Manage collection"
                        : "Create collection"
                      : modal.kind === "bulk"
                        ? "Bulk markup"
                        : modal.kind === "excel"
                          ? "Catalogue Excel"
                          : modal.kind === "fast-entry" ? "Fast Product Entry" : "Customer quotation"
          }
          close={() => void closeDialog()}
        >
          {modal.kind === "product" && (
            <FamilyForm
              formRef={productForm}
              profileId={profile.id}
              initial={modal.family}
              tree={departments}
              order={orderedDepartments}
              category={
                scope === "category" && productDepartment(filter)
                  ? filter
                  : (scope === "department" && departments[filter]?.[0]) ||
                    departments[orderedDepartments[0]]?.[0] || ""
              }
              groups={data.collections}
              selectedCollection={
                scope === "collection" && data.collections.includes(filter)
                  ? filter
                  : undefined
              }
              cancel={() => void closeDialog()}
              onSave={async (family, nextDepartments, collections, departmentOrder) => {
                await save(
                  {
                    ...data,
                    departments: nextDepartments,
                    departmentOrder,
                    collections,
                    families: modal.family
                      ? data.families.map((f) =>
                          f.id === family.id ? family : f,
                        )
                      : [...data.families, family],
                  },
                  "Product saved.",
                );
                D(null);
              }}
            />
          )}
          {modal.kind === "collection" && (
            <CollectionForm
              current={modal.current}
              families={data.families}
              groups={data.collections}
              close={() => D(null)}
              onSave={(name, ids) =>
                save(
                  {
                    ...data,
                    collections: data.collections.includes(name)
                      ? data.collections
                      : [...data.collections, name],
                    families: data.families.map((f) => ({
                      ...f,
                      collections: [
                        ...f.collections.filter((g) => g !== name),
                        ...(ids.includes(f.id) ? [name] : []),
                      ],
                    })),
                  },
                  "Collection saved.",
                )
              }
            />
          )}
          {modal.kind === "snapshot" && (
            <Snapshot
              products={products}
              businessName={profile.business_name}
              initialProduct={modal.id}
            />
          )}
          {modal.kind === "customer" && (
            <CustomerForm
              collections={allGroups}
              initial={modal.c}
              close={() => D(null)}
              onSave={async (c) => {
                if (
                  data.customers.some(
                    (x) => x.phone === c.phone && x.id !== c.id,
                  )
                )
                  throw Error(
                    "This number is already in the customer directory.",
                  );
                await save(
                  {
                    ...data,
                    customers: modal.c
                      ? data.customers.map((old) => (old.id === c.id ? c : old))
                      : [...data.customers, c],
                  },
                  "Customer saved.",
                );
                choose(c);
              }}
            />
          )}
          {modal.kind === "rate" && (
            <RateForm
              p={modal.p}
              close={() => D(null)}
              onSave={(rate) =>
                save(
                  {
                    ...data,
                    families: data.families.map((f) =>
                      f.id !== modal.p.familyId
                        ? f
                        : {
                            ...f,
                            variants: f.variants.map((v) =>
                              v.id !== modal.p.id || v.rate === rate
                                ? v
                                : {
                                    ...v,
                                    rate,
                                    history: [
                                      ...v.history,
                                      { at: new Date().toISOString(), rate },
                                    ],
                                  },
                            ),
                          },
                    ),
                  },
                  "Rate saved.",
                )
              }
            />
          )}
          {modal.kind === "draft" && (
            <QuotationForm key={modal.customerId} workspace={data} customerId={modal.customerId} save={save} />
          )}
          {modal.kind === "bulk" && (
            <BulkPricingForm workspace={data} variantIds={modal.variantIds} save={save} close={() => D(null)} />
          )}
          {modal.kind === "fast-entry" && (
            <FastEntryForm formRef={productForm} workspace={data} profileId={profile.id}
              initialCategory={scope === "category" && productDepartment(filter) ? filter :
                (scope === "department" && departments[filter]?.[0]) || departments[orderedDepartments[0]]?.[0] || ""}
              initialCollection={scope === "collection" && data.collections.includes(filter) ? filter : undefined}
              onSave={save} close={() => D(null)} />
          )}
          {modal.kind === "excel" && (
            <CatalogueExcelDialog workspace={data} save={save} close={() => D(null)} />
          )}
        </Dialog>
      )}
    </div>
  );
}
type BuyerProduct = Pick<
  Product,
  "id" | "familyId" | "name" | "variant" | "category" | "unit" | "photo"
>;
function Buyer({ profile, checkSession }: { profile: OwnerProfile; checkSession: () => Promise<void> }) {
  const raw =
    new URLSearchParams(location.search).get("collection") || "Full catalog";
  const group = raw;
  const [items, I] = useState<BuyerProduct[]>([]),
    [state, S] = useState("Loading catalog…"),
    [find, F] = useState(""),
    [qty, Q] = useState<Record<string, number>>({}),
    [copied, setCopied] = useState("");
  async function load() {
    S("Loading catalog…");
    try {
      const r = await fetch(
        "/api/buyer?collection=" + encodeURIComponent(group),
        { headers: { "X-Owner-Profile": profile.id } },
      );
      if (r.status === 404) {
        I([]);
        S("This collection is unavailable.");
        return;
      }
      if (r.status === 401 || r.status === 403) await checkSession();
      if (!r.ok) throw Error();
      const d = await r.json();
      I(d.products);
      S("");
    } catch {
      S("The catalog could not load. Please refresh.");
    }
  }
  useEffect(() => {
    void load();
  }, [group, profile.id, checkSession]);
  const [sizeChoices, chooseSize] = useState<Record<string, string>>({});
  const buyerFamilies = new Map<string, BuyerProduct[]>();
  for (const item of items) {
    if (
      ![item.name, item.variant, item.category]
        .join(" ")
        .toLowerCase()
        .includes(find.trim().toLowerCase())
    )
      continue;
    const groupItems = buyerFamilies.get(item.familyId) || [];
    groupItems.push(item);
    buyerFamilies.set(item.familyId, groupItems);
  }
  const selected = items.filter((p) => qty[p.id] > 0);
  const message =
    "Hello " + profile.business_name + ", please quote the following items:\n" +
    selected
      .map(
        (p) =>
          p.name +
          (p.variant ? " — " + p.variant : "") +
          " · " +
          qty[p.id] +
          " × " +
          p.unit,
      )
      .join("\n");
  return (
    <div className="buyer">
      <header>
        <img src="/logo.png" alt="XL Traders" />
        <span>Buyer preview</span>
        <a className="secondary" href="/">
          Workspace
        </a>
      </header>
      <main>
        <div className="heading">
          <div>
            <h1>{group}</h1>
            <p>
              Select items and quantities for an enquiry.
            </p>
          </div>
        </div>
        <SearchBox value={find} set={F} placeholder="Search this collection" />
        {state ? (
          <Notice>
            {state}{" "}
            <button className="link" onClick={() => void load()}>
              <RefreshCw size={14} /> Refresh
            </button>
          </Notice>
        ) : items.length === 0 ? (
          <div className="empty panel">
            <ShoppingBasket size={36} />
            <h2>This collection is waiting for its first product.</h2>
            <p>
              Verified items will appear here with photos and selling units.
            </p>
          </div>
        ) : (
          <div className="buyergrid">
            {Array.from(buyerFamilies, ([familyId, variants]) => {
              const p =
                variants.find((item) => item.id === sizeChoices[familyId]) ||
                variants[0];
              return (
                <article className="panel productcard" key={familyId}>
                  <img src={p.photo} alt={p.name} />
                  <div>
                    <small>{p.category}</small>
                    <h3>{p.name}</h3>
                    {variants.length > 1 && (
                      <label>
                        Size
                        <select
                          value={p.id}
                          onChange={(e) =>
                            chooseSize({
                              ...sizeChoices,
                              [familyId]: e.target.value,
                            })
                          }
                        >
                          {variants.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.variant}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <p>
                      {variants.length === 1 && p.variant
                        ? p.variant + " · "
                        : ""}
                      Per {p.unit.toLowerCase()}
                    </p>
                    <b>Ask for rate</b>
                    <label>
                      Quantity
                      <input
                        type="number"
                        min="0"
                        max="99999"
                        step="1"
                        value={qty[p.id] || ""}
                        placeholder="0"
                        onChange={(e) =>
                          Q({
                            ...qty,
                            [p.id]: Math.min(
                              99999,
                              Math.max(
                                0,
                                Math.floor(Number(e.target.value) || 0),
                              ),
                            ),
                          })
                        }
                      />
                    </label>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {items.length > 0 && !buyerFamilies.size && (
          <p>No items match this search.</p>
        )}
        {selected.length > 0 && (
          <div className="enquiry">
            <b>{selected.length} selected</b>
            <button
              className="primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(message);
                  setCopied("Enquiry copied.");
                } catch {
                  setCopied("Could not copy the enquiry.");
                }
              }}
            >
              Copy enquiry
            </button>
            {copied && <span role="status">{copied}</span>}
          </div>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <SessionBoundary>
    {(session) => location.pathname === "/buyer"
      ? <Buyer key={session.profile.id} {...session} />
      : <App key={session.profile.id} {...session} />}
  </SessionBoundary>,
);
