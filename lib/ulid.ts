/**
 * Minimal ULID generator (Crockford base32, 128-bit, time-sortable).
 *
 * No deps — we don't want to pull in a 3rd-party package for what is
 * ~40 lines. If we ever need monotonic generation under high contention
 * we can swap to the `ulid` npm package.
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

const randomChar = (): string => {
  const rand = Math.floor(Math.random() * ENCODING_LEN);
  return ENCODING.charAt(rand);
};

const encodeTime = (now: number): string => {
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    out = ENCODING.charAt(mod) + out;
    now = (now - mod) / ENCODING_LEN;
  }
  return out;
};

const encodeRandom = (len: number): string => {
  let out = "";
  for (let i = 0; i < len; i++) out += randomChar();
  return out;
};

export const ulid = (): string =>
  encodeTime(Date.now()) + encodeRandom(RANDOM_LEN);
