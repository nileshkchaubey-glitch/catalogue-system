import assert from "node:assert/strict";
import test from "node:test";
import { newEntry, newRow, duplicateEntry, parseVariantPaste, prepareNewProduct } from "../src/features/product-entry/entry.ts";
import { reviewedProductToEntry } from "../src/features/product-entry/extraction-contract.ts";
const at="2026-11-28T10:00:00.000Z";
const workspace={schema:3, departments:{Packaging:["Trays"]}, families:[], customers:[], collections:["Wholesale"],quoteSnapshots:[]};
test("fast entry validates all rows and creates only private drafts",()=>{
 const draft={...newEntry("Trays",["Wholesale"],"Pack"), name:"Tray",rows:parseVariantPaste("250 ml\tPack\t4\t5.50\n500 ml\t\t\t7","Pack")};
 const next=prepareNewProduct(workspace,draft,at);
 assert.equal(workspace.families.length,0);
 assert.equal(next.families.length,1);
 const [a,b]=next.families[0].variants;
 assert.equal(a.purchase,"4.00"); assert.equal(a.rate,"5.50");
 assert.equal(b.purchase,""); assert.equal(b.ready,false); assert.equal(a.ready,false);
 assert.deepEqual(a.history,[{at,rate:"5.50"}]);
 assert.notEqual(a.id,b.id);
 assert.strictEqual(next.quoteSnapshots,workspace.quoteSnapshots);
 assert.throws(()=>prepareNewProduct(next,draft,at),/already exists/);
 assert.throws(()=>prepareNewProduct(workspace,{...draft,rows:[a,{...newRow("Pack"),variant:"250 ML"}]},at),/distinct name/);
 assert.throws(()=>prepareNewProduct(workspace,{...draft,rows:[{...a,rate:"1.234"}]},at),/two decimal/);
});
test("duplicate uses fresh IDs and does not copy prices, history or verification",()=>{
 const draft={...newEntry("Trays"),name:"Tray",photo:"/api/photos/"+"a".repeat(64),rows:[{...newRow(),rate:"9"}]};
 const family=prepareNewProduct(workspace,draft,at).families[0];
 const copy=duplicateEntry(family,true);
 assert.equal(copy.name,""); assert.equal(copy.photo,family.photo);
 assert.equal(copy.rows[0].rate,""); assert.equal(copy.rows[0].purchase,"");
 assert.notEqual(copy.rows[0].id,family.variants[0].id);
 assert.equal(duplicateEntry(family,false).photo,"");
 assert.throws(()=>parseVariantPaste("Small\tUnknown\t1\t2","Pack"),/unknown selling unit/);
});
test("reviewed extraction maps unknown values to empty private draft fields",()=>{
 const entry=reviewedProductToEntry({name:"Reviewed tray",category:"Trays",collections:[],variants:[{size:"Small",unit:"Pack",purchase:null,selling:"9.50"}]});
 const next=prepareNewProduct(workspace,entry,at);
 assert.equal(next.families[0].variants[0].purchase,"");
 assert.equal(next.families[0].variants[0].rate,"9.50");
 assert.equal(next.families[0].variants[0].ready,false);
});
