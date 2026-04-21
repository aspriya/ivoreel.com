import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // IMPORTANT: Do NOT add `export const runtime = "edge"` anywhere.
  // All routes run on the Node.js runtime under @opennextjs/cloudflare.
  serverExternalPackages: [
    // These are used in Node-runtime code paths only.
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
  ],
};

// Wire up Cloudflare bindings in dev. See: https://opennext.js.org/cloudflare
initOpenNextCloudflareForDev();

export default nextConfig;
