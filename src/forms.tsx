import { useState } from "react";
import type { FormEvent } from "react";
import { english, digits, money, featuredCollection, fullCatalog } from "./model";
import type { Product, Customer, Collection } from "./model";
import { normalizeRate, validPrice } from "./pricing";
type Submit<T> = (value: T) => Promise<void>;
function Footer({
  busy,
  close,
  label,
}: {
  busy: boolean;
  close: () => void;
  label: string;
}) {
  return (
    <footer>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={close}
      >
        Cancel
      </button>
      <button className="primary" disabled={busy}>
        {busy ? "Saving…" : label}
      </button>
    </footer>
  );
}
export function CustomerForm({
  initial,
  collections,
  onSave,
  close,
}: {
  initial?: Customer;
  collections: string[];
  onSave: Submit<Customer>;
  close: () => void;
}) {
  const [c, set] = useState<Customer>(
    initial ?? {
      id: crypto.randomUUID(),
      name: "",
      phone: "",
      collection: collections.includes(featuredCollection) ? featuredCollection : fullCatalog,
      consent: false,
    },
  );
  const [busy, B] = useState(false),
    [error, E] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    const phone = digits(c.phone);
    if (!/^\d{8,15}$/.test(phone))
      return E(
        "Enter a ten-digit Indian mobile number or include the international country code.",
      );
    if (!c.name.trim() || !english(c.name))
      return E("Enter the customer or business name in English.");
    B(true);
    try {
      await onSave({ ...c, name: c.name.trim(), phone });
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
        Customer or business name
        <input
          required
          maxLength={100}
          value={c.name}
          onChange={(e) => set({ ...c, name: e.target.value })}
        />
      </label>
      <label>
        WhatsApp number
        <input
          type="tel"
          required
          value={c.phone}
          placeholder="+91"
          onChange={(e) => set({ ...c, phone: e.target.value })}
        />
      </label>
      <label>
        Preferred collection
        <select
          value={c.collection}
          onChange={(e) =>
            set({ ...c, collection: e.target.value as Collection })
          }
        >
          {collections.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={c.consent}
          onChange={(e) => set({ ...c, consent: e.target.checked })}
        />
        <span>
          This customer requested the catalog and agreed to receive it on
          WhatsApp.
        </span>
      </label>
      {error && <p role="alert">{error}</p>}
      <Footer busy={busy} close={close} label="Save customer" />
    </form>
  );
}
export function RateForm({
  p,
  onSave,
  close,
}: {
  p: Product;
  onSave: Submit<string>;
  close: () => void;
}) {
  const [value, V] = useState(p.rate),
    [busy, B] = useState(false),
    [error, E] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!validPrice(value))
      return E("Enter a positive rate with up to two decimal places.");
    B(true);
    try {
      await onSave(normalizeRate(value, p.rate));
      close();
    } catch (e) {
      E((e as Error).message);
    } finally {
      B(false);
    }
  }
  return (
    <form noValidate onSubmit={submit}>
      <strong>{p.name}</strong>
      <p>
        {p.variant || p.category} · Current rate: {money(p.rate)} per{" "}
        {p.unit.toLowerCase()}
      </p>
      <label>
        New rate per {p.unit.toLowerCase()} (INR)
        <input
          required
          inputMode="decimal"
          value={value}
          onChange={(e) => V(e.target.value)}
        />
      </label>
      {p.history.length > 0 && (
        <details>
          <summary>Rate history</summary>
          {p.history
            .slice()
            .reverse()
            .map((h, i) => (
              <p key={i}>
                {new Date(h.at).toLocaleString("en-IN")} · {money(h.rate)}
              </p>
            ))}
        </details>
      )}
      {error && <p role="alert">{error}</p>}
      <Footer busy={busy} label="Save rate" close={close} />
    </form>
  );
}
