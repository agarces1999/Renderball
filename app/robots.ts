import type { MetadataRoute } from "next";

// Public marketing surface is indexable; the app (previews, editor, account)
// is private and stays out of crawlers.
//
// /s/ is reachable without an account but is NOT public in the sense a crawler
// means: it is one person's document, sent to specific people. The page carries
// noindex of its own; this is the second lock, for anything that reads robots
// before it reads the page.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/preview/",
        "/review/",
        "/documents",
        "/videos",
        "/account",
        "/billing",
        "/new",
        "/dev/",
        "/s/",
      ],
    },
    sitemap: "https://renderball.com/sitemap.xml",
  };
}
