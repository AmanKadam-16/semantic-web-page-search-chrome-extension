// Tiny static server for demo-dist/ (run `npm run build` first).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../demo-dist");
const port = Number(process.env.PORT) || 5173;
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const file = path.join(root, decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`Demo running at http://localhost:${port}`));
