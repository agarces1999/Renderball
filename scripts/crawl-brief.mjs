import * as esbuild from "esbuild";
import { writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
const out = await esbuild.build({ entryPoints: ["scripts/crawl-brief.ts"], bundle: true, platform: "node", format: "esm", target: "node18", packages: "external", write: false, logLevel: "silent" });
const f = join(process.cwd(), "node_modules", ".cache", "crawl-brief.mjs");
writeFileSync(f, out.outputFiles[0].text);
await import(pathToFileURL(f).href);
