import { permanentRedirect } from "next/navigation";

/**
 * /videos → /documents (canvas pivot, docs/PIVOT.md).
 *
 * The gallery moved to /documents when the product pivoted from video
 * generation to AI-native design documents. This stub keeps every old link,
 * bookmark, and sign-in redirect working.
 */
export default function VideosPage(): never {
  permanentRedirect("/documents");
}
