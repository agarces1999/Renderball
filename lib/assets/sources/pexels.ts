/**
 * Pexels photo source. Pexels License: free for commercial use, no
 * attribution required — so every result is commercial-safe (no per-asset
 * license filtering needed, unlike LottieFiles later). We still record the
 * photographer credit in the manifest as good practice.
 *
 * Key: process.env.PEXELS_API_KEY (Authorization header). `fetchImpl` is
 * injectable so the mapping is unit-testable without a key or network.
 */

import type { AssetCandidate, AssetOrientation } from "../types";

export const PEXELS_LICENSE =
  "Pexels License — free for commercial use, no attribution required";

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer?: string;
  alt?: string;
  src: {
    original: string;
    large2x?: string;
    large?: string;
    medium?: string;
    small?: string;
  };
}

export interface SearchOpts {
  orientation?: AssetOrientation;
  perPage?: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export const searchPexelsPhotos = async (
  query: string,
  opts: SearchOpts = {},
): Promise<AssetCandidate[]> => {
  const apiKey = opts.apiKey ?? process.env.PEXELS_API_KEY;
  if (!apiKey) {
    throw new Error("PEXELS_API_KEY is not set — add it to .env.local");
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    query,
    per_page: String(opts.perPage ?? 6),
  });
  // Pexels orientation values are landscape | portrait | square.
  if (opts.orientation) params.set("orientation", opts.orientation);

  const res = await doFetch(`https://api.pexels.com/v1/search?${params.toString()}`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    throw new Error(`Pexels search failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { photos?: PexelsPhoto[] };
  return (data.photos ?? []).map((p) => ({
    id: `pexels-photo-${p.id}`,
    type: "photo" as const,
    source: "pexels" as const,
    thumbUrl: p.src.medium ?? p.src.small ?? p.src.original,
    fullUrl: p.src.large2x ?? p.src.large ?? p.src.original,
    width: p.width,
    height: p.height,
    license: PEXELS_LICENSE,
    attribution: p.photographer,
  }));
};

interface PexelsVideoFile {
  id: number;
  quality?: string; // "hd" | "sd" | "uhd"
  file_type?: string; // "video/mp4"
  width?: number;
  height?: number;
  link: string;
}
interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number; // seconds
  image: string; // poster frame
  user?: { name?: string };
  video_files: PexelsVideoFile[];
}

/**
 * Pick the best MP4: the widest file that's still ≤ 1920px (1080p is plenty
 * for a 1920-wide canvas; 4K files are huge and slow the render). Falls back
 * to the smallest mp4, then any file.
 */
const pickVideoFile = (files: PexelsVideoFile[]): PexelsVideoFile | undefined => {
  const mp4 = files.filter((f) => (f.file_type ?? "").includes("mp4"));
  const pool = mp4.length > 0 ? mp4 : files;
  if (pool.length === 0) return undefined;
  const underCap = pool.filter((f) => (f.width ?? 0) <= 1920);
  const ranked = (underCap.length > 0 ? underCap : pool)
    .slice()
    .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return ranked[0];
};

export const searchPexelsVideos = async (
  query: string,
  opts: SearchOpts = {},
): Promise<AssetCandidate[]> => {
  const apiKey = opts.apiKey ?? process.env.PEXELS_API_KEY;
  if (!apiKey) {
    throw new Error("PEXELS_API_KEY is not set — add it to .env.local");
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    query,
    per_page: String(opts.perPage ?? 5),
  });
  if (opts.orientation) params.set("orientation", opts.orientation);

  const res = await doFetch(
    `https://api.pexels.com/videos/search?${params.toString()}`,
    { headers: { Authorization: apiKey } },
  );
  if (!res.ok) {
    throw new Error(`Pexels video search failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { videos?: PexelsVideo[] };
  return (data.videos ?? [])
    .map((v): AssetCandidate | null => {
      const file = pickVideoFile(v.video_files ?? []);
      if (!file) return null;
      return {
        id: `pexels-video-${v.id}`,
        type: "video",
        source: "pexels",
        thumbUrl: v.image,
        fullUrl: file.link,
        width: file.width ?? v.width,
        height: file.height ?? v.height,
        durationS: v.duration,
        license: PEXELS_LICENSE,
        attribution: v.user?.name,
      };
    })
    .filter((c): c is AssetCandidate => c !== null);
};
