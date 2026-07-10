import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://renderball.com", changeFrequency: "weekly", priority: 1 },
    { url: "https://renderball.com/terms", changeFrequency: "monthly", priority: 0.2 },
    { url: "https://renderball.com/privacy", changeFrequency: "monthly", priority: 0.2 },
  ];
}
