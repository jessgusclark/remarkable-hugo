import crypto from "node:crypto";
import { config } from "./config.js";

const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

export function verifySignature(
  timestamp: string,
  token: string,
  signature: string,
): boolean {
  if (!timestamp || !token || !signature) {
    console.warn(
      `Signature check failed: missing field(s) (timestamp=${!!timestamp} token=${!!token} signature=${!!signature})`,
    );
    return false;
  }
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_MAX_AGE_SECONDS) {
    console.warn(
      `Signature check failed: timestamp out of range (age=${age}s, max=${SIGNATURE_MAX_AGE_SECONDS}s) — check server clock or a stale/replayed request`,
    );
    return false;
  }
  const expected = crypto
    .createHmac("sha256", config.mailgunSigningKey)
    .update(timestamp + token)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    console.warn(
      "Signature check failed: signature mismatch — verify MAILGUN_SIGNING_KEY matches the current key in Mailgun (Settings -> API security). Rotating the key invalidates the old one immediately.",
    );
  }
  return match;
}
