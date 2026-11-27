import { useEffect, useState } from "react";
import { Download, Share2, MessageCircle } from "lucide-react";
import { chat, money } from "./model";
import type { Product, Customer } from "./model";
function image(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(Error("The photo could not load. Reopen the snapshot to retry."));
    img.src = src;
  });
}
function lines(ctx: CanvasRenderingContext2D, value: string, width: number) {
  const rows: string[] = [];
  let row = "";
  for (const word of value.split(/\s+/)) {
    const candidate = row ? row + " " + word : word;
    if (ctx.measureText(candidate).width <= width) {
      row = candidate;
      continue;
    }
    if (row) {
      rows.push(row);
      row = "";
    }
    for (const ch of word) {
      if (row && ctx.measureText(row + ch).width > width) {
        rows.push(row);
        row = "";
      }
      row += ch;
    }
  }
  if (row) rows.push(row);
  return rows;
}
export async function renderSnapshot(p: Product, date: string): Promise<File> {
  const [photo, logo] = await Promise.all([image(p.photo), image("/logo.png")]);
  const c = document.createElement("canvas");
  c.width = 1000;
  const ctx = c.getContext("2d");
  if (!ctx) throw Error("Snapshot creation is unavailable.");
  ctx.font = "bold 48px Arial";
  const name = lines(ctx, p.name, 870);
  ctx.font = "32px Arial";
  const details = lines(
    ctx,
    [p.variant, p.category].filter(Boolean).join("  ·  "),
    870,
  );
  c.height = 960 + name.length * 56 + details.length * 42;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  function contain(
    img: HTMLImageElement,
    x: number,
    y: number,
    w: number,
    h: number,
  ) {
    const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const iw = img.naturalWidth * scale,
      ih = img.naturalHeight * scale;
    ctx!.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
  }
  contain(logo, 55, 28, 143, 82);
  ctx.fillStyle = "#526164";
  ctx.font = "27px Arial";
  ctx.textAlign = "right";
  ctx.fillText(date, 940, 77);
  ctx.textAlign = "left";
  ctx.fillStyle = "#b63832";
  ctx.fillRect(0, 133, 1000, 7);
  contain(photo, 55, 165, 890, 510);
  let y = 754;
  ctx.fillStyle = "#253137";
  ctx.font = "bold 48px Arial";
  for (const line of name) {
    ctx.fillText(line, 60, y);
    y += 56;
  }
  ctx.font = "32px Arial";
  ctx.fillStyle = "#556266";
  for (const line of details) {
    ctx.fillText(line, 60, y);
    y += 42;
  }
  ctx.fillStyle = "#253137";
  ctx.font = "bold 47px Arial";
  ctx.fillText(money(p.rate) + " / " + p.unit.toLowerCase(), 60, y + 41);
  ctx.fillStyle = "#eff3f1";
  ctx.fillRect(0, c.height - 87, 1000, 87);
  ctx.fillStyle = "#253137";
  ctx.font = "27px Arial";
  ctx.fillText("XL Traders  ·  WhatsApp +91 9773239442", 60, c.height - 34);
  const blob = await new Promise<Blob>((ok, no) =>
    c.toBlob(
      (b) => (b ? ok(b) : no(Error("Could not create the snapshot."))),
      "image/png",
    ),
  );
  return new File(
    [blob],
    ("XL-Traders-" + p.name + "-" + (p.variant || p.unit))
      .replace(/[^a-z0-9-]+/gi, "-")
      .slice(0, 110) + ".png",
    { type: "image/png" },
  );
}
type Media = { file: File; url: string; key: string };
export function Snapshot({
  products,
  customers,
  initialProduct,
  customerId,
}: {
  products: Product[];
  customers: Customer[];
  initialProduct?: string;
  customerId: string;
}) {
  const eligible = products.filter((p) => p.ready && p.photo && p.rate);
  const [id, P] = useState(initialProduct || eligible[0]?.id || ""),
    [contact, C] = useState(customerId),
    [media, M] = useState<Media | null>(null),
    [error, E] = useState(""),
    [retry, R] = useState(0);
  const product = eligible.find((p) => p.id === id),
    customer = customers.find((c) => c.id === contact && c.consent);
  const date = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(new Date());
  const key = product
    ? JSON.stringify([
        product.id,
        product.photo,
        product.rate,
        product.name,
        product.variant,
        product.category,
        product.unit,
        date,
      ])
    : "";
  useEffect(() => {
    let cancelled = false;
    let url = "";
    M(null);
    E("");
    if (product)
      renderSnapshot(product, date)
        .then((file) => {
          if (cancelled) return;
          url = URL.createObjectURL(file);
          M({ file, url, key });
        })
        .catch((e) => {
          if (!cancelled) E((e as Error).message);
        });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [key, retry]);
  const ready = media?.key === key ? media : null;
  const caption = product
    ? [
        "*XL Traders*",
        "*" + product.name + "*",
        [product.variant, product.category].filter(Boolean).join(" · "),
        "Rate: " + money(product.rate) + " per " + product.unit.toLowerCase(),
        "Quoted on " + date,
      ].join("\n")
    : "";
  const canShare =
    !!ready &&
    !!navigator.share &&
    !!navigator.canShare?.({ files: [ready.file] });
  async function share() {
    if (!ready || !customer) return;
    E("");
    try {
      const withCaption = { files: [ready.file], text: caption };
      await navigator.share(
        navigator.canShare?.(withCaption)
          ? withCaption
          : { files: [ready.file] },
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        E(
          "File sharing is unavailable here. Download the image and attach it in WhatsApp.",
        );
    }
  }
  return (
    <div className="draft snapshot">
      <label>
        Product and size
        <select value={id} onChange={(e) => P(e.target.value)}>
          <option value="">Select a verified size</option>
          {eligible.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
              {p.variant ? " · " + p.variant : ""} · {money(p.rate)} /{" "}
              {p.unit.toLowerCase()}
            </option>
          ))}
        </select>
      </label>
      {!eligible.length && (
        <p>
          Add a verified product photo and a selling rate to prepare a snapshot.
        </p>
      )}
      {product && (
        <>
          <label>
            Customer
            <select
              value={customer?.id || ""}
              onChange={(e) => C(e.target.value)}
            >
              <option value="">
                Select a customer with catalog permission
              </option>
              {customers
                .filter((c) => c.consent)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          {ready ? (
            <img
              className="card-preview"
              alt={
                "Snapshot of " + product.name + " with its price and details"
              }
              src={ready.url}
            />
          ) : (
            !error && <p role="status">Preparing image…</p>
          )}
          {ready && (
            <>
              <details>
                <summary>WhatsApp caption</summary>
                <pre>{caption}</pre>
              </details>
              {customer && (
                <p>
                  Recipient: <b>{customer.name}</b> · +{customer.phone}
                </p>
              )}
              {canShare && (
                <>
                  <button
                    className="primary"
                    disabled={!customer}
                    onClick={() => void share()}
                  >
                    <Share2 size={16} /> Share image
                  </button>
                  <small>
                    Choose WhatsApp and the intended recipient in your device’s
                    share menu.
                  </small>
                </>
              )}
              <div className="card-actions">
                <a
                  className="secondary"
                  href={ready.url}
                  download={ready.file.name}
                >
                  <Download size={16} /> Download image
                </a>
                {customer && (
                  <a
                    className="secondary"
                    href={chat(customer.phone, caption)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <MessageCircle size={16} /> Open customer chat
                  </a>
                )}
              </div>
              <small>
                To attach manually, download the image, open the customer chat
                and attach the PNG. The image includes the rate even without a
                caption.
              </small>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          {!ready && (
            <button className="link" onClick={() => R(retry + 1)}>
              Retry
            </button>
          )}
        </p>
      )}
    </div>
  );
}
