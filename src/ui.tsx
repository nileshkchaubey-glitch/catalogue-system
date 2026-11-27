import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  X,
  Leaf,
  Layers3,
  Package,
  Container,
  ScrollText,
  CupSoda,
  UtensilsCrossed,
  ChevronRight,
  BookOpen,
  PanelTop,
} from "lucide-react";
import { categories } from "./model";
export const icons = [
  Leaf,
  Layers3,
  Package,
  Container,
  ScrollText,
  CupSoda,
  UtensilsCrossed,
];
export const colors = [
  "sage",
  "apricot",
  "blue",
  "slate",
  "violet",
  "rose",
  "ochre",
];
export function CategoryIcon({ category }: { category: string }) {
  const i = Math.max(
    0,
    categories.findIndex((c) => c === category),
  );
  const Icon = icons[i % icons.length];
  return (
    <span className={"tileicon " + colors[i % colors.length]}>
      <Icon size={23} strokeWidth={1.65} />
    </span>
  );
}
export function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dlg = ref.current;
    dlg?.showModal();
    return () => dlg?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button className="iconbtn" aria-label="Close dialog" onClick={close}>
          <X />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Hero({ open }: { open: () => void }) {
  return (
    <section className="hero">
      <div className="hero-copy">
        <span className="hero-label">
          <BookOpen size={15} /> Featured collection
        </span>
        <h2>Restaurant &amp; Takeaway</h2>
        <p>Choose the products you want restaurant buyers to see.</p>
        <button className="light" onClick={open}>
          View collection <ChevronRight size={16} />
        </button>
      </div>
      <div className="sheets" aria-hidden="true">
        <div className="sheet back" />
        <div className="sheet middle" />
        <div className="sheet cover">
          <PanelTop size={23} />
          <b>CATALOG</b>
          <i />
          <i />
        </div>
      </div>
    </section>
  );
}
