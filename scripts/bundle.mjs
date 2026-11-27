import fs from "node:fs";
import path from "node:path";
const assets = {};
function visit(dir) {
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    if (fs.statSync(f).isDirectory()) visit(f);
    else {
      const type = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css",
        ".js": "text/javascript",
        ".png": "image/png",
      }[path.extname(f)];
      if (type)
        assets["/" + path.relative("dist", f)] = {
          type,
          data: fs.readFileSync(f).toString("base64"),
        };
    }
  }
}
visit("dist");
const core = fs
  .readFileSync("server/worker.mjs", "utf8")
  .replace(
    /^import taxonomy from [^;]+;/m,
    "const taxonomy = " + fs.readFileSync("shared/taxonomy.json", "utf8") + ";",
  );
const handler = `
export default {async fetch(req,env){
 const url=new URL(req.url);
 if(url.pathname.startsWith('/api/')){try{return await handleAPI(req,env.BUCKET)}catch{return error('The workspace is unavailable. Please try again.',503)}}
 const asset=assets[url.pathname==='/'||url.pathname==='/buyer'?'/index.html':url.pathname];
 if(!asset)return new Response('Page unavailable.',{status:404});
 return new Response(Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0)),{headers:{'content-type':asset.type,'x-content-type-options':'nosniff','referrer-policy':'no-referrer','cache-control':'private, no-cache'}});
}};
`;
fs.mkdirSync("dist/server", { recursive: true });
fs.writeFileSync(
  "dist/server/index.js",
  core + "\nconst assets=" + JSON.stringify(assets) + ";\n" + handler,
);
fs.mkdirSync("dist/.openai", { recursive: true });
fs.copyFileSync(".openai/hosting.json", "dist/.openai/hosting.json");
