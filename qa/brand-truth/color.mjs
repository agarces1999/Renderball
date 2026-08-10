// Colour distance. Two numbers, on purpose.
//
// PRIMARY: Euclidean distance in sRGB, because that is what the founder's
// hand-measured table used (stripe #533afd vs #635bff = 37, duolingo
// #00b086 vs #58cc02 = 161) and the bands EXACT<30 / NEAR<90 / WRONG>=90 were
// drawn against those numbers. Changing the metric under a set of bands
// silently redefines every verdict, so the primary metric does not move.
//
// SECONDARY: CIEDE2000 in CIELAB, reported alongside as a diagnostic. It is
// perceptually uniform where RGB is not — RGB says #ffb3c7 and #ffa8cd are 12
// apart and also says two dark navies are 12 apart, and only one of those
// pairs looks identical to a person. No dependency: the transform is 30 lines.
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export const parseHex = (hex) => {
  if (typeof hex !== "string") return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export const rgbDistance = (a, b) => {
  const x = parseHex(a),
    y = parseHex(b);
  if (!x || !y) return null;
  return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2);
};

const toLab = (hex) => {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const lin = rgb
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = lin;
  // sRGB D65
  const X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const Z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(X),
    fy = f(Y),
    fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

const rad = (d) => (d * Math.PI) / 180;
const hueDeg = (b, ap) => {
  if (ap === 0 && b === 0) return 0;
  const d = (Math.atan2(b, ap) * 180) / Math.PI;
  return d >= 0 ? d : d + 360;
};

/** CIEDE2000. Reference implementation; verified against Sharma's test pairs. */
export const deltaE2000 = (hexA, hexB) => {
  const A = toLab(hexA),
    B = toLab(hexB);
  if (!A || !B) return null;
  return deltaE2000Lab(A, B);
};

export const deltaE2000Lab = ([L1, a1, b1], [L2, a2, b2]) => {
  const C1 = Math.hypot(a1, b1),
    C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1,
    a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1),
    C2p = Math.hypot(a2p, b2);
  const h1p = hueDeg(b1, a1p),
    h2p = hueDeg(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else {
    const d = Math.abs(h1p - h2p);
    if (d <= 180) hbp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hbp = (h1p + h2p + 360) / 2;
    else hbp = (h1p + h2p - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos(rad(hbp - 30)) +
    0.24 * Math.cos(rad(2 * hbp)) +
    0.32 * Math.cos(rad(3 * hbp + 6)) -
    0.2 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
};

export const BANDS = { EXACT: 30, NEAR: 90 };

/** Band a chromatic pick against a chromatic truth. */
export const bandOf = (distance) =>
  distance < BANDS.EXACT ? "EXACT" : distance < BANDS.NEAR ? "NEAR" : "WRONG";

export const _clamp = clamp;
