import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CURRENT_MASTER_KEY_VERSION,
  decodeMasterKey,
  decrypt,
  encrypt,
  lastFour,
  safeEqual
} from "@agentrouter/secret-box";

const masterKey = randomBytes(32).toString("base64");

describe("secret-box AES-256-GCM", () => {
  it("round-trips plaintext through encrypt → decrypt", () => {
    const plaintext = "sk-proj-abcdEFGH1234zzzz";
    const enc = encrypt(plaintext, masterKey);

    expect(enc.iv).toHaveLength(12);
    expect(enc.tag).toHaveLength(16);
    expect(enc.keyVersion).toBe(CURRENT_MASTER_KEY_VERSION);
    // Ciphertext must not contain the plaintext bytes.
    expect(enc.ciphertext.toString("utf8")).not.toContain(plaintext);

    expect(decrypt(enc, masterKey)).toBe(plaintext);
  });

  it("produces a unique IV (and thus ciphertext) per call", () => {
    const a = encrypt("same-secret", masterKey);
    const b = encrypt("same-secret", masterKey);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("fails to decrypt with the wrong master key", () => {
    const enc = encrypt("top-secret", masterKey);
    const otherKey = randomBytes(32).toString("base64");
    expect(() => decrypt(enc, otherKey)).toThrow();
  });

  it("fails to decrypt when the auth tag is tampered", () => {
    const enc = encrypt("top-secret", masterKey);
    const badTag = Buffer.from(enc.tag);
    badTag.writeUInt8(badTag.readUInt8(0) ^ 0xff, 0);
    expect(() => decrypt({ ...enc, tag: badTag }, masterKey)).toThrow();
  });

  it("rejects a master key that is not 32 bytes", () => {
    expect(() => decodeMasterKey(randomBytes(16).toString("base64"))).toThrow();
    expect(() => encrypt("x", "not-base64-and-short")).toThrow();
  });

  it("exposes only the last four chars for display", () => {
    expect(lastFour("sk-proj-abcdEFGH1234zzzz")).toBe("zzzz");
  });

  it("compares secrets in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
