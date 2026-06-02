import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

/**
 * Envelope encryption for at-rest secrets (BYOK provider keys), AES-256-GCM.
 *
 * The master key lives ONLY on the Fly side (API + worker) — never on Vercel.
 * decision #4. Plaintext is handled at exactly two boundaries: the API's
 * POST /v1/provider-keys (encrypt) and the worker's run launch (decrypt).
 */

/** Current master-key version. Bump when rotating the master key. */
export const CURRENT_MASTER_KEY_VERSION = 1;

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16; // 128-bit auth tag
const KEY_BYTES = 32; // AES-256

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

/**
 * Decodes a base64 master key and asserts it is exactly 32 bytes. Throws a
 * clear error otherwise so a misconfigured env fails fast at boot/use.
 */
export function decodeMasterKey(masterKeyBase64: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(masterKeyBase64, "base64");
  } catch {
    throw new Error("AGENTROUTER_MASTER_KEY is not valid base64");
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `AGENTROUTER_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`
    );
  }
  return key;
}

/** Encrypts UTF-8 plaintext with the (base64-encoded) master key. */
export function encrypt(plaintext: string, masterKeyBase64: string): EncryptedSecret {
  const key = decodeMasterKey(masterKeyBase64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return { ciphertext, iv, tag, keyVersion: CURRENT_MASTER_KEY_VERSION };
}

/** Decrypts an encrypted row back to UTF-8 plaintext. Throws if tampered. */
export function decrypt(
  row: { ciphertext: Buffer; iv: Buffer; tag: Buffer; keyVersion?: number },
  masterKeyBase64: string
): string {
  const key = decodeMasterKey(masterKeyBase64);
  if (row.iv.length !== IV_BYTES) {
    throw new Error("Invalid IV length for AES-256-GCM");
  }
  if (row.tag.length !== TAG_BYTES) {
    throw new Error("Invalid auth tag length for AES-256-GCM");
  }

  const decipher = createDecipheriv(ALGO, key, row.iv);
  decipher.setAuthTag(row.tag);
  return Buffer.concat([
    decipher.update(row.ciphertext),
    decipher.final()
  ]).toString("utf8");
}

/** Last 4 chars of a secret, for display (e.g. sk-proj-…EgGT). Never the key. */
export function lastFour(secret: string): string {
  return secret.slice(-4);
}

/** Constant-time equality for two same-purpose secrets/hashes. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
