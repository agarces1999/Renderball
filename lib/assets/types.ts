/**
 * Shared types for the auxiliary asset library — free-to-use, commercial-safe
 * media (photos now; video + Lottie in later phases) the design agent queries
 * via `search_assets` and we cache locally + bake into the composition.
 */

export type AssetType = "photo" | "video" | "lottie";
export type AssetOrientation = "landscape" | "portrait" | "square";
export type AssetSource = "pexels" | "lottiefiles" | "brand"; // "brand" = the brand's own crawled imagery

/**
 * One candidate the agent can choose from. `fullUrl` is what we download +
 * cache; `thumbUrl` is a small preview the agent can be shown cheaply.
 */
export interface AssetCandidate {
  id: string;
  type: AssetType;
  source: AssetSource;
  thumbUrl: string;
  fullUrl: string;
  width: number;
  height: number;
  /** Seconds — video only. */
  durationS?: number;
  /** Human-readable license string, recorded in the manifest for auditability. */
  license: string;
  /** Optional creator credit (recorded even when attribution isn't required). */
  attribution?: string;
}

/**
 * A record of one `search_assets` call (query + the candidates returned),
 * collected during the design pass and written to assets-manifest.json so
 * every asset that could enter a render is license-auditable.
 */
export interface AssetSearchEntry {
  query: string;
  type: AssetType;
  candidates: {
    url: string;
    width: number;
    height: number;
    license: string;
    attribution?: string;
  }[];
}

/** Manifest entry written per cached asset so usage is auditable + license-traceable. */
export interface CachedAssetEntry {
  query: string;
  type: AssetType;
  source: AssetSource;
  srcUrl: string; // the remote URL we downloaded from
  localPath: string; // path the composition references (relative to genDir)
  sha: string;
  width: number;
  height: number;
  durationS?: number;
  license: string;
  attribution?: string;
}
