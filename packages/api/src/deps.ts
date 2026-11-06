// Everything the routes need from the outside world, injected so tests can replace it.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { type GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createPresignedPost, type PresignedPostOptions } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { type Config, loadConfig } from "./config.ts";
import type { SessionUser } from "./session.ts";

export type { SessionUser };

/** The ID token claims sesame reads. */
export interface IdClaims {
  sub: string;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  nonce?: unknown;
  /** Present for users who signed in through a federated IdP. */
  identities?: unknown;
  "cognito:groups"?: unknown;
}

export type Log = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export interface Deps {
  config: Config;
  doc: DynamoDBDocumentClient;
  s3: S3Client;
  presign: (command: GetObjectCommand, expiresIn: number) => Promise<string>;
  presignPost: (options: PresignedPostOptions) => Promise<{ url: string; fields: Record<string, string> }>;
  sqs: SQSClient;
  verifyIdToken: (token: string) => Promise<IdClaims>;
  fetch: typeof fetch;
  now: () => number;
  log: Log;
}

export type Env = { Variables: { deps: Deps; user: SessionUser } };

export const log: Log = (level, msg, fields) => {
  console[level](JSON.stringify({ level, msg, ...fields }));
};

export async function createDeps(): Promise<Deps> {
  const config = await loadConfig();
  const s3 = new S3Client({});
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: "id",
    clientId: config.clientId,
  });
  return {
    config,
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    s3,
    presign: (command, expiresIn) => getSignedUrl(s3, command, { expiresIn }),
    presignPost: (options) => createPresignedPost(s3, options),
    sqs: new SQSClient({}),
    verifyIdToken: async (token) => (await verifier.verify(token)) as unknown as IdClaims,
    fetch: globalThis.fetch,
    now: Date.now,
    log,
  };
}
