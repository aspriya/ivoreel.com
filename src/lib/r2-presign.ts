/**
 * R2 presigned URLs via the AWS S3 presigner.
 *
 * The Workers R2 binding does NOT expose `createSignedUrl`, so for any
 * out-of-Worker consumer (e.g. Trigger.dev) we sign URLs against R2's
 * S3-compatible endpoint with account-scoped access keys.
 */
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function client(env: CloudflareEnv) {
  return new S3Client({
    region: "auto",
    endpoint: env.R2_S3_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

export async function presignGet(
  env: CloudflareEnv,
  key: string,
  expiresIn = 3600,
): Promise<string> {
  return getSignedUrl(
    client(env),
    new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
    { expiresIn },
  );
}

export async function presignPut(
  env: CloudflareEnv,
  key: string,
  expiresIn = 3600,
): Promise<string> {
  return getSignedUrl(
    client(env),
    new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
    { expiresIn },
  );
}
