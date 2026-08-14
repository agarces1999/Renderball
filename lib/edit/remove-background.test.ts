/**
 * Background removal — the deterministic half of the icon pipeline. Cases are
 * the ones real generations produce: near-white fields (never pure white),
 * antialiased edges, interior regions the same color as the background (a
 * white cutout inside the mark must SURVIVE — only border-connected field is
 * background), and a blank generation (degrade to the original, never emit
 * an empty file).
 */
import sharp from "sharp";
import { removeBackground } from "./remove-background";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
};
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};

/** Alpha at (x,y) of a PNG. */
const alphaAt = async (png: Buffer, x: number, y: number): Promise<number> => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * 4 + 3];
};

/** An SVG-drawn test PNG — sharp renders it with real antialiasing. */
const render = (svg: string): Promise<Buffer> => sharp(Buffer.from(svg)).png().toBuffer();

console.log("remove-background (icon pipeline step 2)");

const run = async () => {
  await check("near-white field goes transparent; the mark stays opaque", async () => {
    // The models never deliver pure white — #f4f4f2, like SSD-1B's field.
    const png = await render(
      `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
         <rect width="200" height="200" fill="#f4f4f2"/>
         <circle cx="100" cy="100" r="52" fill="#16324f"/>
       </svg>`,
    );
    const { png: out, removedRatio } = await removeBackground(png);
    // Trimmed to the circle + 6% pad → the center is opaque mark, the corner
    // is inside the pad ring → transparent.
    const meta = await sharp(out).metadata();
    assert((meta.width ?? 0) < 140 && (meta.width ?? 0) > 90, `trimmed to content, got ${meta.width}px wide`);
    const midAlpha = await alphaAt(out, Math.floor((meta.width ?? 2) / 2), Math.floor((meta.height ?? 2) / 2));
    const cornerAlpha = await alphaAt(out, 1, 1);
    assert(midAlpha > 240, `mark center opaque, got ${midAlpha}`);
    assert(cornerAlpha < 12, `pad corner transparent, got ${cornerAlpha}`);
    assert(removedRatio > 0.5, `most of the field removed, got ${removedRatio.toFixed(2)}`);
  });

  await check("an interior region matching the background SURVIVES (border-connected only)", async () => {
    const png = await render(
      `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
         <rect width="200" height="200" fill="#ffffff"/>
         <rect x="40" y="40" width="120" height="120" fill="#c02020"/>
         <rect x="85" y="85" width="30" height="30" fill="#ffffff"/>
       </svg>`,
    );
    const { png: out } = await removeBackground(png);
    const meta = await sharp(out).metadata();
    // The white square INSIDE the red block is content, not background.
    const inner = await alphaAt(out, Math.floor((meta.width ?? 2) / 2), Math.floor((meta.height ?? 2) / 2));
    assert(inner > 240, `interior white kept opaque, got ${inner}`);
  });

  await check("a blank generation returns the original instead of an empty file", async () => {
    const png = await render(
      `<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg">
         <rect width="64" height="64" fill="#fafafa"/>
       </svg>`,
    );
    const { png: out } = await removeBackground(png);
    const meta = await sharp(out).metadata();
    assert((meta.width ?? 0) === 64, "original dimensions preserved");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};
await run();
