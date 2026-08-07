/**
 * Reading an attached image.
 *
 * NOTHING HERE MAKES A LIVE CALL. This is the one attachment path that spends
 * money, so every test either injects the transport or mocks `fetch` — a test
 * suite that can bill the account is a test suite nobody runs.
 *
 * The fixtures are REAL images, not byte-prefixes pretending to be images: the
 * PNG is assembled chunk by chunk with correct CRCs and then handed to a
 * decoder to prove it, and the JPEG / WebP / GIF are encoded from it. A reader
 * fed only bytes its own author wrote proves very little (the lesson from
 * read-svg.test.ts, which pins itself against two real files on disk).
 */
import { deflateSync } from "zlib";
import sharp from "sharp";
import {
  IMAGE_READ_PROMPT,
  MAX_IMAGE_BYTES,
  VISION_BASE64_LIMIT,
  base64Bytes,
  readImage,
  type ImageVisionTransport,
} from "./read-image";
import { noteZaiError, resetZaiBreakerForTests, zaiBreakerState } from "../zai-breaker";
import { EMPTY_USAGE, type Usage } from "../usage";

let passed = 0;
let failed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
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

/** The text of an ok result, or a thrown explanation of why it was refused. */
const textOf = (r: Awaited<ReturnType<typeof readImage>>): string => {
  if (!r.ok) throw new Error(`expected readable text, was refused: ${r.reason}`);
  return r.text;
};

/**
 * The refusal message, or a thrown explanation of what came back instead. Same
 * two accessors as read-svg.test.ts, and for the same reason: a plain assert()
 * does not narrow the union, and widening the type to quiet the compiler would
 * let a refusal quietly carry text.
 */
const reasonOf = (r: Awaited<ReturnType<typeof readImage>>): string => {
  if (r.ok) throw new Error(`expected a refusal, got text: ${JSON.stringify(r.text.slice(0, 80))}`);
  return r.reason;
};

// ── real image fixtures ─────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (b: Buffer): number => {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const pngChunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A genuine 2x2 8-bit RGB PNG. Every chunk length and CRC is computed. */
const makePng = (): Buffer => {
  const w = 2;
  const h = 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10,11,12 = compression 0, filter 0, interlace 0 — already zero.
  // One filter byte per scanline, then w*3 colour bytes.
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    rows.push(Buffer.from([0, 0x96, 0xc8, 0xff, 0x0b, 0x0f, 0x1a]));
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

const PNG = makePng();
const JPEG = await sharp(PNG).jpeg().toBuffer();
const WEBP = await sharp(PNG).webp().toBuffer();
const GIF = await sharp(PNG).gif().toBuffer();

// ── transport doubles ───────────────────────────────────────────────────────

interface Recorder {
  transport: ImageVisionTransport;
  calls: { image: string; prompt: string }[];
}

/** A transport that answers with `reply` and records what it was sent. */
const answering = (reply: string, usage: Usage = EMPTY_USAGE): Recorder => {
  const calls: { image: string; prompt: string }[] = [];
  return {
    calls,
    transport: async (image, prompt) => {
      calls.push({ image, prompt });
      return { text: reply, usage };
    },
  };
};

/** A transport that throws — and records that it was reached at all. */
const throwing = (err: unknown): Recorder => {
  const calls: { image: string; prompt: string }[] = [];
  return {
    calls,
    transport: async (image, prompt) => {
      calls.push({ image, prompt });
      throw err;
    },
  };
};

console.log("image reading (the one attachment path that spends)");

// ── the fixtures are real ───────────────────────────────────────────────────

await check("the PNG fixture is a real PNG, not bytes that merely start like one", async () => {
  const meta = await sharp(PNG).metadata();
  assert(meta.format === "png", `decoder read format ${meta.format}`);
  assert(meta.width === 2 && meta.height === 2, `decoded ${meta.width}x${meta.height}`);
});

await check("the JPEG fixture really is a JPEG and carries the SOI marker", async () => {
  assert(JPEG[0] === 0xff && JPEG[1] === 0xd8 && JPEG[2] === 0xff, "not a JPEG header");
  assert((await sharp(JPEG).metadata()).format === "jpeg", "decoder disagrees");
});

// ── the happy path ──────────────────────────────────────────────────────────

await check("a PNG of a slide comes back as pasteable prose", async () => {
  const t = answering("Four day close\nZero spreadsheets\nQ3 revenue up 42%");
  const r = await readImage(PNG, "old-slide.png", { transport: t.transport });
  assert(
    textOf(r) === "Four day close\nZero spreadsheets\nQ3 revenue up 42%",
    `unexpected text: ${JSON.stringify(textOf(r))}`,
  );
  assert(t.calls.length === 1, `expected exactly one paid call, made ${t.calls.length}`);
});

await check("the model's ragged whitespace is tidied before it reaches the brief", async () => {
  const t = answering("  Four day close   \n\n\n\n  Zero spreadsheets\t\t\n ");
  const r = await readImage(PNG, "whiteboard.jpg", { transport: t.transport });
  assert(
    textOf(r) === "Four day close\n\nZero spreadsheets",
    `whitespace not collapsed: ${JSON.stringify(textOf(r))}`,
  );
});

await check("the image reaches the transport intact — the bytes round-trip", async () => {
  // This is the failure that blinded the whole vision layer once: the model was
  // answering about a picture it never received. Proving the payload survives
  // is the only assertion that would have caught it.
  const t = answering("Anything");
  await readImage(PNG, "slide.png", { transport: t.transport });
  const sent = t.calls[0].image;
  assert(sent.startsWith("data:image/png;base64,"), `not a data URL: ${sent.slice(0, 40)}`);
  const back = Buffer.from(sent.slice("data:image/png;base64,".length), "base64");
  assert(back.equals(PNG), "the bytes that arrived are not the bytes we were given");
});

await check("a JPEG is labelled image/jpeg, never image/png", async () => {
  // callZaiVision stamps bare base64 as image/png unconditionally, so the mime
  // has to be settled here. A JPEG announced as a PNG is a decode failure
  // waiting at the provider, for an image that was perfectly fine.
  const t = answering("Whiteboard notes");
  await readImage(JPEG, "photo.jpg", { transport: t.transport });
  assert(
    t.calls[0].image.startsWith("data:image/jpeg;base64,"),
    `wrong mime on the wire: ${t.calls[0].image.slice(0, 40)}`,
  );
});

await check("WebP and GIF are accepted and each labelled with its own format", async () => {
  const w = answering("From a webp");
  await readImage(WEBP, "shot.webp", { transport: w.transport });
  assert(
    w.calls[0].image.startsWith("data:image/webp;base64,"),
    `webp mislabelled: ${w.calls[0].image.slice(0, 40)}`,
  );
  const g = answering("From a gif");
  await readImage(GIF, "shot.gif", { transport: g.transport });
  assert(
    g.calls[0].image.startsWith("data:image/gif;base64,"),
    `gif mislabelled: ${g.calls[0].image.slice(0, 40)}`,
  );
});

await check("the extension is never trusted — a PNG named .jpg is still read as a PNG", async () => {
  const t = answering("Read anyway");
  const r = await readImage(PNG, "screenshot.jpg", { transport: t.transport });
  assert(r.ok, "a renamed file the user can plainly see is an image must still be read");
  assert(
    t.calls[0].image.startsWith("data:image/png;base64,"),
    `followed the extension instead of the bytes: ${t.calls[0].image.slice(0, 40)}`,
  );
});

await check("a .txt name on real image bytes is still read", async () => {
  const t = answering("Read anyway");
  assert((await readImage(PNG, "notes.txt", { transport: t.transport })).ok, "bytes decide, not the name");
});

// ── the prompt ──────────────────────────────────────────────────────────────

await check("the prompt forbids invention and asks for plain prose, not JSON", async () => {
  assert(/do not invent/i.test(IMAGE_READ_PROMPT), "must forbid inventing content");
  assert(/do not guess/i.test(IMAGE_READ_PROMPT), "must forbid guessing at unreadable words");
  assert(/no json/i.test(IMAGE_READ_PROMPT), "must ask for text, not JSON");
  assert(/chart|diagram/i.test(IMAGE_READ_PROMPT), "must ask for one line about a chart or diagram");
  assert(/heading/i.test(IMAGE_READ_PROMPT), "must ask for headings");
  assert(/number/i.test(IMAGE_READ_PROMPT), "must ask for numbers");
});

await check("the prompt the transport receives is the exported one", async () => {
  const t = answering("Text");
  await readImage(PNG, "a.png", { transport: t.transport });
  assert(t.calls[0].prompt === IMAGE_READ_PROMPT, "a second prompt has appeared from somewhere");
});

// ── things that are not images ──────────────────────────────────────────────

await check("a non-image buffer is refused without spending a call", async () => {
  const t = answering("should never be reached");
  const r = await readImage(Buffer.from("Just a brief someone typed into a file."), "brief.txt", {
    transport: t.transport,
  });
  const why = reasonOf(r);
  assert(t.calls.length === 0, "refusing a non-image must not cost a model call");
  assert(/paste/i.test(why), `must offer the route that always works: ${why}`);
  assert(!/undefined|null|Error|stack/i.test(why), `reason must read as English: ${why}`);
});

await check("a PDF gets the PDF advice, not the generic one", async () => {
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64)]);
  const why = reasonOf(await readImage(pdf, "one-pager.pdf"));
  assert(/pdf/i.test(why), `must name the format it actually is: ${why}`);
  assert(/screenshot|paste/i.test(why), `must offer a route forward: ${why}`);
});

await check("an SVG is sent to the free reader instead of a paid one", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>Q3</text></svg>');
  const why = reasonOf(await readImage(svg, "chart.svg"));
  assert(/svg/i.test(why), `must name the format: ${why}`);
  assert(!/png|jpeg/i.test(why), `telling an SVG owner to attach a PNG wastes a free read: ${why}`);
});

await check("an empty buffer is refused, not sent", async () => {
  const t = answering("should never be reached");
  assert(!(await readImage(Buffer.alloc(0), "empty.png", { transport: t.transport })).ok, "nothing to read");
  assert(t.calls.length === 0, "an empty file must not cost a call");
});

await check("a truncated PNG header is not mistaken for a PNG", async () => {
  const t = answering("should never be reached");
  const r = await readImage(PNG_SIGNATURE.subarray(0, 4), "half.png", { transport: t.transport });
  assert(!r.ok, "four of the eight signature bytes is not a PNG");
  assert(t.calls.length === 0, "must not spend on it");
});

// ── size, before any spend ──────────────────────────────────────────────────

await check("the size ceiling really does fit inside the provider's base64 limit", async () => {
  // The arithmetic, pinned: base64 costs a third more than the file on disk, so
  // a ceiling set in file bytes has to be checked in encoded bytes. Raising
  // MAX_IMAGE_BYTES without redoing this goes red here.
  const encoded = base64Bytes(MAX_IMAGE_BYTES);
  assert(encoded < VISION_BASE64_LIMIT, `${encoded} encoded bytes exceeds the documented limit`);
  assert(encoded < 10_000_000, `${encoded} exceeds 10MB even read as a round ten million`);
  assert(
    VISION_BASE64_LIMIT - encoded > 500_000,
    "no headroom left for the prompt and the JSON envelope around the image",
  );
});

await check("an oversized image is refused BEFORE the call, with a size and a route", async () => {
  // Bytes past the signature are never inspected — this test is about the size
  // gate, and a genuinely decodable 7 MB image would take longer to build than
  // the whole suite takes to run.
  const huge = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(MAX_IMAGE_BYTES)]);
  const t = answering("should never be reached");
  const why = reasonOf(await readImage(huge, "photo.png", { transport: t.transport }));
  assert(t.calls.length === 0, "an oversized image must cost nothing to refuse");
  assert(/7 MB/.test(why), `must say how small it needs to be: ${why}`);
  assert(/resize|smaller/i.test(why), `must say what to do about it: ${why}`);
  assert(/paste/i.test(why), `must offer the route that always works: ${why}`);
});

await check("an image exactly at the ceiling is still read", async () => {
  const atLimit = Buffer.concat([
    PNG_SIGNATURE,
    Buffer.alloc(MAX_IMAGE_BYTES - PNG_SIGNATURE.length),
  ]);
  assert(atLimit.length === MAX_IMAGE_BYTES, "fixture is not exactly at the ceiling");
  const t = answering("Read it");
  assert((await readImage(atLimit, "big.png", { transport: t.transport })).ok, "the boundary is inclusive");
  assert(t.calls.length === 1, "the boundary case must actually be sent");
});

// ── failures that must never reach the user raw ─────────────────────────────

await check("a transport that throws produces a sentence, not a stack trace", async () => {
  const t = throwing(new Error("fireworks vision 500: upstream connect error reading remote"));
  const why = reasonOf(await readImage(PNG, "slide.png", { transport: t.transport }));
  assert(!/fireworks|500|upstream|connect/i.test(why), `raw provider error leaked: ${why}`);
  assert(/paste|again/i.test(why), `must offer a route forward: ${why}`);
  assert(/nothing was charged/i.test(why), `must say the attempt was free: ${why}`);
});

await check("a timeout abort is not shown as an AbortError", async () => {
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  const why = reasonOf(await readImage(PNG, "slide.png", { transport: throwing(abort).transport }));
  assert(!/abort/i.test(why), `AbortError leaked to the user: ${why}`);
});

await check("a thrown non-Error does not break the refusal path", async () => {
  const why = reasonOf(await readImage(PNG, "slide.png", { transport: throwing("plain string").transport }));
  assert(why.length > 20 && /paste|again/i.test(why), `must still be a usable sentence: ${why}`);
});

await check("an empty answer is a refusal, not an empty brief", async () => {
  const why = reasonOf(await readImage(PNG, "slide.png", { transport: answering("").transport }));
  assert(/paste|sharper/i.test(why), `must offer a route forward: ${why}`);
});

await check("whitespace-only answer is treated the same as empty", async () => {
  const r = await readImage(PNG, "slide.png", { transport: answering("   \n\n\t  ").transport });
  assert(!r.ok, "whitespace is not content");
});

await check("the NO TEXT sentinel never lands in the brief as the words 'NO TEXT'", async () => {
  for (const reply of ["NO TEXT", "no text", "NO TEXT.", " NO_TEXT \n"]) {
    const r = await readImage(PNG, "logo.png", { transport: answering(reply).transport });
    assert(!r.ok, `"${reply}" must be a refusal, not text`);
    assert(!/^NO[ _]TEXT/i.test(reasonOf(r)), `the sentinel leaked into the message: ${reasonOf(r)}`);
  }
});

await check("text that merely mentions no text is still text", async () => {
  const t = answering("No text was legible on the left panel, but the heading reads Q3 close.");
  const r = await readImage(PNG, "slide.png", { transport: t.transport });
  assert(r.ok, "the sentinel check must not swallow a real sentence");
});

// ── usage accounting ────────────────────────────────────────────────────────

await check("onUsage reports the vision model and the tokens actually billed", async () => {
  const usage: Usage = { ...EMPTY_USAGE, input_tokens: 1420, output_tokens: 380 };
  const seen: { model: string; usage: Usage }[] = [];
  await readImage(PNG, "slide.png", {
    transport: answering("Q3 close", usage).transport,
    onUsage: (model, u) => seen.push({ model, usage: u }),
  });
  assert(seen.length === 1, `expected one usage record, got ${seen.length}`);
  assert(/kimi|glm|fireworks/i.test(seen[0].model), `unexpected model recorded: ${seen[0].model}`);
  assert(seen[0].usage.input_tokens === 1420, "input tokens lost");
  assert(seen[0].usage.output_tokens === 380, "output tokens lost");
});

await check("onUsage does NOT fire when nothing was spent", async () => {
  let fired = 0;
  await readImage(Buffer.from("not an image"), "x.txt", { onUsage: () => fired++ });
  await readImage(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(MAX_IMAGE_BYTES)]), "big.png", {
    onUsage: () => fired++,
  });
  await readImage(PNG, "slide.png", {
    transport: throwing(new Error("boom")).transport,
    onUsage: () => fired++,
  });
  assert(fired === 0, `usage was logged for ${fired} calls that never billed`);
});

// ── the breaker ─────────────────────────────────────────────────────────────

await check("an account-dry error trips the breaker so the next person fails free", async () => {
  resetZaiBreakerForTests();
  const dry = Object.assign(new Error("fireworks vision 402: account has no balance"), { status: 402 });
  const why = reasonOf(await readImage(PNG, "slide.png", { transport: throwing(dry).transport }));
  assert(zaiBreakerState().open, "a balance error must trip the circuit");
  assert(/nothing was charged/i.test(why), `must reassure about the money: ${why}`);
  assert(!/402|balance|account/i.test(why), `provider internals leaked: ${why}`);
  resetZaiBreakerForTests();
});

await check("an ordinary failure does NOT trip the breaker", async () => {
  resetZaiBreakerForTests();
  await readImage(PNG, "slide.png", { transport: throwing(new Error("socket hang up")).transport });
  assert(!zaiBreakerState().open, "a network blip must not take image reading down for everyone");
  resetZaiBreakerForTests();
});

await check("with the breaker open nothing is sent at all", async () => {
  resetZaiBreakerForTests();
  noteZaiError(new Error("[1113] Insufficient balance"));
  const t = answering("should never be reached");
  const why = reasonOf(await readImage(PNG, "slide.png", { transport: t.transport }));
  assert(t.calls.length === 0, "the breaker exists to stop the call happening");
  assert(/paste|again/i.test(why), `must offer a route forward: ${why}`);
  assert(!/video/i.test(why), "the pre-pivot 'video generation' wording must not reach a deck brief");
  resetZaiBreakerForTests();
});

// ── the wire itself, with fetch mocked ──────────────────────────────────────

await check("the default transport posts to Fireworks vision with thinking disabled", async () => {
  // No transport injected: this exercises the production path end to end, with
  // `fetch` swapped out. It is the check that enforces the routing rule — one
  // image wire, thinking off for a terse extraction, a bounded token budget and
  // a timeout — none of which an injected double could ever prove.
  process.env.RB_FIREWORKS_KEY = process.env.RB_FIREWORKS_KEY || "test-key";
  const original = globalThis.fetch;
  const seen: { url: string; body: Record<string, unknown>; hasSignal: boolean }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      hasSignal: !!init?.signal,
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Four day close" } }],
        usage: { prompt_tokens: 1200, completion_tokens: 40 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const r = await readImage(PNG, "slide.png");
    assert(textOf(r) === "Four day close", `unexpected read: ${JSON.stringify(r)}`);
    assert(seen.length === 1, `expected one request, saw ${seen.length}`);
    assert(/api\.fireworks\.ai/.test(seen[0].url), `wrong host: ${seen[0].url}`);
    const body = seen[0].body as {
      messages?: { content?: { type?: string; image_url?: { url?: string } }[] }[];
      max_tokens?: number;
      thinking?: { type?: string };
    };
    assert(body.thinking?.type === "disabled", "a terse extraction must not pay the thinking tax");
    assert(
      typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens <= 2000,
      `token budget is not bounded sensibly: ${body.max_tokens}`,
    );
    assert(seen[0].hasSignal, "a hung vision call must be abortable — no timeout was armed");
    const parts = body.messages?.[0]?.content ?? [];
    const img = parts.find((p) => p.type === "image_url");
    assert(!!img, "the image never made it into the request");
    assert(
      (img?.image_url?.url ?? "").startsWith("data:image/png;base64,"),
      `image arrived mislabelled or empty: ${(img?.image_url?.url ?? "").slice(0, 40)}`,
    );
    assert(parts.some((p) => p.type === "text"), "the prompt never made it into the request");
  } finally {
    globalThis.fetch = original;
  }
});

await check("a provider HTTP error on the real path still reads as English", async () => {
  process.env.RB_FIREWORKS_KEY = process.env.RB_FIREWORKS_KEY || "test-key";
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("Internal Server Error: model not deployed", { status: 503 })) as typeof fetch;
  try {
    const why = reasonOf(await readImage(PNG, "slide.png"));
    assert(!/503|deployed|Internal/i.test(why), `provider body leaked to the user: ${why}`);
    assert(/paste|again/i.test(why), `must offer a route forward: ${why}`);
  } finally {
    globalThis.fetch = original;
    resetZaiBreakerForTests();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
