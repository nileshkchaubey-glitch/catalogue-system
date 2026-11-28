import { readSheet } from "read-excel-file/web-worker";
import { productsSheet } from "./catalogue-excel.ts";

self.addEventListener("message", async (event: MessageEvent<File>) => {
  try {
    self.postMessage({ rows: await readSheet(event.data, productsSheet) });
  } catch {
    self.postMessage({ error: "Could not read the Products sheet. Check that this is an .xlsx file from the template." });
  }
});
