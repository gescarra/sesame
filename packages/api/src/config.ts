// Runtime configuration. Table and bucket names come from the revision's environment.
// Values that depend on CloudFront and Cognito live in one SSM SecureString, because
// the revision is created before the distribution and the app client exist.
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

/** The settings every sesame web function shares: where users reach it, sign-in, and the cookie key. */
export interface SharedConfig {
  /** Origin users reach the app on, e.g. https://d111.cloudfront.net. No trailing slash. */
  publicUrl: string;
  /** Cognito managed login base URL, e.g. https://sesame-x.auth.us-east-1.amazoncognito.com */
  cognitoDomain: string;
  userPoolId: string;
  clientId: string;
  /** Sends users straight to this IdP instead of the Cognito chooser. */
  identityProvider?: string;
  /** 32-byte AES-256-GCM key for session and login cookies. */
  sessionKey: Buffer;
}

export interface Config extends SharedConfig {
  mailTable: string;
  mailBucket: string;
  directoryTable: string;
  /** Internal deliveries and Sent copies go to ingest; external recipients to the sender. */
  ingestQueueUrl: string;
  sendQueueUrl: string;
  /** Messages a user may send per hour. */
  sendRateLimit: number;
  /**
   * Host name phones use as the Exchange server, shown on the Devices page. ActiveSync is
   * served by the same distribution as the app, so it's the app's own host.
   */
  easServer?: string;
}

interface StoredConfig {
  publicUrl: string;
  cognitoDomain: string;
  userPoolId: string;
  clientId: string;
  identityProvider?: string;
  /** base64 */
  sessionKey: string;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

/**
 * Reads SESAME_CONFIG (JSON, for local runs) or the SSM parameter named by
 * SESAME_CONFIG_PARAM. Callers keep the result for the life of the environment.
 */
export async function loadSharedConfig(): Promise<SharedConfig> {
  const raw = process.env.SESAME_CONFIG ?? (await readParameter(env("SESAME_CONFIG_PARAM")));
  const stored = JSON.parse(raw) as StoredConfig;
  for (const key of ["publicUrl", "cognitoDomain", "userPoolId", "clientId", "sessionKey"] as const) {
    if (typeof stored[key] !== "string" || !stored[key]) throw new Error(`config is missing ${key}`);
  }
  const sessionKey = Buffer.from(stored.sessionKey, "base64");
  if (sessionKey.length !== 32) throw new Error("config sessionKey must be 32 bytes");
  const config: SharedConfig = {
    publicUrl: stored.publicUrl.replace(/\/+$/, ""),
    cognitoDomain: stored.cognitoDomain.replace(/\/+$/, ""),
    userPoolId: stored.userPoolId,
    clientId: stored.clientId,
    sessionKey,
  };
  if (stored.identityProvider) config.identityProvider = stored.identityProvider;
  return config;
}

export async function loadConfig(): Promise<Config> {
  const shared = await loadSharedConfig();
  return {
    ...shared,
    easServer: new URL(shared.publicUrl).host,
    mailTable: env("MAIL_TABLE"),
    mailBucket: env("MAIL_BUCKET"),
    directoryTable: env("DIRECTORY_TABLE"),
    ingestQueueUrl: env("INGEST_QUEUE_URL"),
    sendQueueUrl: env("SEND_QUEUE_URL"),
    sendRateLimit: Number(process.env.SEND_RATE_LIMIT ?? 200),
  };
}

async function readParameter(name: string): Promise<string> {
  const res = await new SSMClient({}).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is empty`);
  return value;
}
