import type { MetadataRoute } from "next";

// Public marketing surface is indexable; the app (previews, editor, account)
// is private and stays out of crawlers.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/preview/", "/review/", "/videos", "/account", "/billing", "/new", "/dev/"],
    },
    sitemap: "https://renderball.com/sitemap.xml",
  };
}
