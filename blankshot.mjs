import { promises as fs } from 'fs';
import path from 'path';
import * as esbuild from 'esbuild';
const out=process.cwd()+'/.bs.cjs';
await esbuild.build({entryPoints:['lib/render/scene-iframe.ts'],bundle:true,platform:'node',
  format:'cjs',target:'node18',outfile:out,external:['esbuild','react','react-dom'],logLevel:'silent'});
const { renderSceneDoc } = await import(`file://${out}`);
const bd=process.cwd()+'/.bd2.cjs';
await esbuild.build({entryPoints:['lib/documents/blank-document.ts'],bundle:true,platform:'node',
  format:'cjs',target:'node18',outfile:bd,external:['esbuild'],logLevel:'silent'});
const { blankScript } = await import(`file://${bd}`);
const r = await renderSceneDoc('BLANK_DEMO_DOC', 0, blankScript('BLANK_DEMO_DOC',1));
if(!r.ok){ console.log('FAILED:', r.message); process.exit(1); }
await fs.writeFile('/tmp/blank-doc.html', r.html);
console.log('  blank document HTML written:', (r.html.length/1024).toFixed(1)+'KB');
await fs.rm(out,{force:true}); await fs.rm(bd,{force:true});
