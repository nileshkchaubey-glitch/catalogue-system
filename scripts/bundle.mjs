import fs from "node:fs";
import path from "node:path";
import { build } from "vite";
const assets = {};
function visit(dir) {
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    if (f === path.join("dist", "server")) continue;
    if (fs.statSync(f).isDirectory()) visit(f);
    else {
      const type = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css",
        ".js": "text/javascript",
        ".png": "image/png",
      }[path.extname(f)];
      if (type)
        assets["/" + path.relative("dist", f).split(path.sep).join("/")] = {
          type,
          data: fs.readFileSync(f).toString("base64"),
        };
    }
  }
}
visit("dist");
await build({
  configFile: false,
  publicDir: false,
  plugins: [{
    name: "catalogue-assets",
    resolveId(id) {
      if (id === "virtual:catalogue-assets") return "\0" + id;
    },
    load(id) {
      if (id === "\0virtual:catalogue-assets") return `export default ${JSON.stringify(assets)}`;
    },
  }],
  build: {
    outDir: "dist/server",
    emptyOutDir: true,
    lib: { entry: "server/index.mjs", formats: ["es"], fileName: () => "index.js" },
    target: "esnext",
    minify: false,
    reportCompressedSize: false,
  },
});
