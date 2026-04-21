#!/usr/bin/env tsx
/**
 * Build the Remotion bundle and upload to R2 for use as the serveUrl.
 *
 * Usage:
 *   npx tsx scripts/bundle-remotion.ts
 *
 * Then set REMOTION_SERVE_URL in Trigger.dev to the uploaded R2 public URL.
 */
import { bundle } from "@remotion/bundler";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const R2_ENDPOINT = process.env.R2_S3_ENDPOINT!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET = process.env.R2_BUCKET || "ivoreel";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!; // e.g. https://remotion.ivoreel.com

async function uploadDir(s3: S3Client, localDir: string, prefix: string) {
  const entries = await readdir(localDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(localDir, entry.name);
    const key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await uploadDir(s3, fullPath, key);
    } else {
      const stream = createReadStream(fullPath);
      await s3.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: stream,
          ContentType: guessContentType(entry.name),
        }),
      );
      console.log(`Uploaded: ${key}`);
    }
  }
}

function guessContentType(name: string): string {
  if (name.endsWith(".js")) return "application/javascript";
  if (name.endsWith(".css")) return "text/css";
  if (name.endsWith(".html")) return "text/html";
  if (name.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function main() {
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.error("Missing R2_ env vars");
    process.exit(1);
  }

  console.log("Bundling Remotion...");
  const outDir = await bundle({
    entryPoint: "./remotion/index.ts",
    publicDir: undefined,
  });
  console.log(`Bundle output: ${outDir}`);

  const s3 = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  const prefix = `remotion-bundle/${Date.now()}`;
  await uploadDir(s3, outDir, prefix);

  const serveUrl = `${R2_PUBLIC_URL}/${prefix}/index.html`;
  console.log(`\nREMOTION_SERVE_URL=${serveUrl}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
