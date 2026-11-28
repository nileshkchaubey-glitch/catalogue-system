import { useRef, useState } from "react";
import type { SheetData } from "write-excel-file/browser";
import type { Workspace } from "./model";
import { excelReferenceRows, previewCatalogueExcel, productExcelRows, productsSheet } from "./catalogue-excel";
import type { ExcelPreview } from "./catalogue-excel";

const maxFileBytes = 5 * 1024 * 1024;
const previewLimit = 12;

function readWorkbook(file: File): Promise<unknown[][]> {
  if (!file.name.toLowerCase().endsWith(".xlsx") || !file.size || file.size > maxFileBytes) {
    return Promise.reject(Error("Choose a non-empty .xlsx file under 5 MB."));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./catalogue-excel.worker.ts", import.meta.url), { type: "module" });
    const fail = (message: string) => finish(() => reject(Error(message)));
    const timer = setTimeout(() => fail("This workbook took too long to read. Try a smaller file."), 15000);
    function finish(complete: () => void) {
      clearTimeout(timer);
      worker.terminate();
      complete();
    }
    worker.onmessage = ({ data }: MessageEvent<{ rows?: unknown[][]; error?: string }>) => {
      if (data.rows) finish(() => resolve(data.rows!));
      else fail(data.error ?? "Could not read this workbook.");
    };
    worker.onerror = () => fail("Could not read this workbook.");
    worker.onmessageerror = () => fail("Could not read this workbook.");
    worker.postMessage(file);
  });
}

function spreadsheetRows(rows: (string | number | null)[][]): SheetData {
  return rows.map((row, index) => row.map((value) => {
    if (value === null) return null;
    if (typeof value === "number") return { value, type: Number, format: "0.00" };
    return index === 0
      ? { value, type: String, fontWeight: "bold", backgroundColor: "#E7EDE8" }
      : { value, type: String };
  }));
}

export function CatalogueExcelDialog({ workspace, save, close }: {
  workspace: Workspace;
  save: (workspace: Workspace, message: string) => Promise<void>;
  close: () => void;
}) {
  const [preview, setPreview] = useState<ExcelPreview | null>(null);
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState<"read" | "download" | "save" | null>(null);
  const issueRef = useRef<HTMLParagraphElement>(null);
  const previewRef = useRef<HTMLHeadingElement>(null);
  const newProducts = preview?.products.filter((product) => product.isNew).length ?? 0;

  function showIssue(message: string) {
    setIssue(message);
    requestAnimationFrame(() => issueRef.current?.focus());
  }

  async function download(template: boolean) {
    setBusy("download");
    setIssue("");
    try {
      const { default: writeExcelFile } = await import("write-excel-file/browser");
      const date = new Date().toISOString().slice(0, 10);
      await writeExcelFile([
        {
          sheet: productsSheet, stickyRowsCount: 1,
          columns: [39, 39, 33, 29, 22, 15, 25, 25].map((width) => ({ width })),
          data: spreadsheetRows(productExcelRows(workspace, template)),
        },
        {
          sheet: "Reference", stickyRowsCount: 1,
          columns: [31, 31, 15].map((width) => ({ width })),
          data: spreadsheetRows(excelReferenceRows(workspace)),
        },
      ]).toFile(template ? "catalogue-import-template.xlsx" : `catalogue-products-${date}.xlsx`);
    } catch {
      showIssue("Could not create the Excel download. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function inspect(file: File) {
    setBusy("read");
    setIssue("");
    setPreview(null);
    try {
      setPreview(previewCatalogueExcel(workspace, await readWorkbook(file), new Date().toISOString()));
      requestAnimationFrame(() => previewRef.current?.focus());
    } catch (error) {
      showIssue((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    if (!preview?.products.length || busy) return;
    setBusy("save");
    setIssue("");
    try {
      await save(preview.workspace, `Excel import saved for ${preview.products.length} products.`);
      close();
    } catch (error) {
      showIssue((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="excel-dialog">
      <p>Download the product catalogue or use the template to add products and update prices. The download includes internal purchase prices.</p>
      <div className="card-actions">
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void download(false)}>Download Excel</button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void download(true)}>Download import template</button>
      </div>
      <label>
        Upload Excel
        <input type="file" accept=".xlsx" disabled={!!busy} onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void inspect(file);
        }} />
      </label>
      <p className="muted">Use one row per variant. Leave IDs blank for new products. To edit existing rows, keep the IDs in your download. Blank prices keep existing prices. Use categories and units from the Reference sheet. Upload up to 2,000 rows per file.</p>
      {busy && <p role="status">{busy === "save" ? "Saving import…" : busy === "read" ? "Reading workbook…" : "Preparing download…"}</p>}
      {issue && <p className="excel-issue" ref={issueRef} tabIndex={-1} role="alert">{issue}</p>}
      {preview && (
        <section className="sizebox">
          <h3 ref={previewRef} tabIndex={-1}>Review Excel import</h3>
          <p>{preview.rows} rows read. {newProducts} new products, {preview.products.length - newProducts} updated products.</p>
          {!preview.products.length ? <p>This workbook matches the current catalogue.</p> : (
            <ul className="excel-review">
              {preview.products.slice(0, previewLimit).map((product, index) =>
                <li key={index}>{product.name} <small>{product.isNew ? "New" : "Update"}</small></li>,
              )}
              {preview.products.length > previewLimit && <li>{preview.products.length - previewLimit} more products</li>}
            </ul>
          )}
        </section>
      )}
      <footer>
        <button type="button" className="secondary" disabled={busy === "save"} onClick={close}>Close</button>
        <button type="button" className="primary" disabled={!!busy || !preview?.products.length} onClick={() => void confirm()}>Confirm import</button>
      </footer>
    </div>
  );
}
