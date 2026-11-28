import assert from "node:assert/strict";
import test from "node:test";
import { readSheet } from "read-excel-file/node";
import writeExcelFile from "write-excel-file/node";
import { excelColumns, productsSheet } from "../../src/catalogue-excel.ts";
import { createLocalFixture, owners } from "./local-fixture.mjs";
import { launchChromium, waitFor } from "./chromium.mjs";

const button = (label) => '[...document.querySelectorAll("button")].find(el=>el.textContent.trim()==='
  + JSON.stringify(label) + ' && !el.disabled && el.getClientRects().length)';
const dialog = 'document.querySelector("dialog[open]")';
const content = (label) => "document.body.innerText.includes(" + JSON.stringify(label) + ")";
const mediaCards = '[...document.querySelectorAll(".gallery-photo")]';

async function signIn(page, owner) {
  await page.navigate();
  await waitFor(() => page.visible(button("Sign in")), "sign-in form");
  await page.focus('document.querySelector("input[name=email]")');
  await page.type(owner.email);
  await page.focus('document.querySelector("input[name=password]")');
  await page.type(owner.password);
  await page.click(button("Sign in"));
  await waitFor(() => page.visible(button("Catalogue Excel")), "product toolbar");
}

test("owner imports and downloads Excel, drops photos and saves reordered gallery", { timeout: 60_000 }, async (t) => {
  const app = await createLocalFixture(t);
  const owner = owners.mobile;
  const browser = await launchChromium();
  const pages = [];
  t.after(async () => {
    try {
      for (const page of pages) await page.close();
    } finally {
      await browser.close();
    }
  });
  const page = await browser.newPage(app.origin, { width: 1366, height: 900 });
  pages.push(page);
  await signIn(page, owner);
  await page.click(button("Catalogue Excel"));
  await waitFor(() => page.visible(dialog), "Excel dialog");
  const data = [
    excelColumns,
    [null, null, "Imported test tray", "Silver foil containers", "250 ml", "Pack", 4, 8.99],
    [null, null, "Imported test tray", "Silver foil containers", "500 ml", "Pack", null, 12],
  ].map(row => row.map(value => value == null ? null : { value, type: typeof value === "number" ? Number : String }));
  const file = await writeExcelFile(data, { sheet: productsSheet }).toBuffer();
  await page.evaluate("(() => {" +
    "const bytes=Uint8Array.from(atob(" + JSON.stringify(file.toString("base64")) + "),c=>c.charCodeAt(0));" +
    "const input=document.querySelector('dialog input[type=file]'); const files=new DataTransfer();" +
    "files.items.add(new File([bytes],'catalogue-input.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));" +
    "input.files=files.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()");
  await waitFor(() => page.visible(content("Review Excel import")), "Excel review from the packaged Worker");
  assert.equal(app.rows.has(owner.id), false);
  await page.click(button("Confirm import"));
  await waitFor(async () => !(await page.visible(dialog)), "Excel import saved");
  const imported = app.rows.get(owner.id).document.families[0];
  assert.equal(imported.name, "Imported test tray");
  assert.deepEqual(imported.variants.map(v => v.rate), ["8.99", "12.00"]);

  await page.click(button("Catalogue Excel"));
  await page.evaluate("(() => {" +
    "const create=URL.createObjectURL.bind(URL);" +
    "URL.createObjectURL=blob=>{window.catalogueBytes=blob.arrayBuffer().then(b=>btoa(String.fromCharCode(...new Uint8Array(b))));return create(blob);};" +
    "HTMLAnchorElement.prototype.click=function(){if(this.href.startsWith('blob:')&&this.download.endsWith('.xlsx'))window.catalogueDownload=window.catalogueBytes;}; })()");
  await page.click(button("Download Excel"));
  const encoded = await waitFor(() => page.evaluate("window.catalogueDownload || null"), "Excel download");
  const exported = await readSheet(Buffer.from(encoded,"base64"), productsSheet);
  assert.equal(exported[1][0], imported.id);
  assert.equal(exported[1][1], imported.variants[0].id);
  assert.equal(exported[1][7], 8.99);
  await page.key("Escape");
  await waitFor(async () => !(await page.visible(dialog)), "Excel dialog closed");

  await page.click(button("Add product"));
  await waitFor(() => page.visible(dialog), "product editor");
  await page.focus('[...document.querySelectorAll("dialog[open] label")].find(l=>l.textContent.trim()==="Product name").querySelector("input")');
  await page.type("Gallery test tray");
  await page.evaluate("(async () => {" +
    "const files=new DataTransfer(); const canvas=document.createElement('canvas'); canvas.width=canvas.height=8;" +
    "const ctx=canvas.getContext('2d'); for(const colour of ['red','teal']){" +
    "ctx.fillStyle=colour;ctx.fillRect(0,0,8,8);const photo=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));" +
    "files.items.add(new File([photo],colour+'.png',{type:'image/png'}));}" +
    "document.querySelector('input[aria-label=\"Choose gallery photos\"]').closest('label').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:files})); })()");
  await waitFor(async () => await page.evaluate(mediaCards + ".length") === 2, "two uploaded photos");
  const originalOrder = await page.evaluate(mediaCards + ".map(card=>card.querySelector('img').getAttribute('src'))");
  await page.evaluate("(() => {const cards=" + mediaCards + ";const dataTransfer=new DataTransfer();" +
    "cards[1].dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer}));" +
    "cards[0].dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));" +
    "cards[0].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer})); })()");
  await waitFor(() => page.visible(content("Cover photo changed.")), "cover changed by dragging");
  assert.deepEqual(await page.evaluate(mediaCards + ".map(card=>card.querySelector('img').getAttribute('src'))"), originalOrder.toReversed());
  await page.click(button("Save product"));
  await waitFor(async () => !(await page.visible(dialog)), "gallery saved");
  const gallery = app.rows.get(owner.id).document.families.find(f => f.name === "Gallery test tray");
  assert.equal(gallery.photo, originalOrder[1]);
  assert.deepEqual(gallery.gallery, [originalOrder[0]]);

  const mobile = await browser.newPage(app.origin, { width: 390, height: 844, mobile: true });
  pages.push(mobile);
  await signIn(mobile, owner);
  assert.equal(await mobile.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await mobile.click(button("Catalogue Excel"));
  await waitFor(() => mobile.visible(button("Download Excel")), "mobile Excel action");
  assert.equal(await mobile.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  assert.deepEqual(page.outside.concat(mobile.outside), []);
  assert.deepEqual(page.errors.concat(mobile.errors), []);
});
