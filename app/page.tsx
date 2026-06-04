import { redirect } from "next/navigation";

/**
 * Root → /new redirect.
 *
 * The real product entry point is the brief wizard at /new. The legacy
 * landing page that previewed an example MP4 was tied to V0.1's
 * elements[]-based composition and `launch-15s` example data, both of
 * which got deleted in the 2026-05-28 cleanup pass. If we want a real
 * landing page later (brand pitch, sign-in, recent renders), build it
 * on top of the current architecture rather than restoring the old one.
 */
export default function RootPage(): never {
  redirect("/new");
}
