import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import { config } from "./config.js";
import { pdfToImages, transcribe } from "./convert.js";
import { initRepo, publish } from "./publish.js";

const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;
const SEEN_TOKENS_MAX = 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
});

function verifySignature(
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

function senderAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

// Tokens of deliveries we've already accepted, so a Mailgun retry (e.g. after
// the forward timed out mid-pipeline) doesn't publish a duplicate.
const seenTokens = new Set<string>();

// One pipeline run at a time: concurrent runs would race the git working tree.
let pipelineQueue: Promise<unknown> = Promise.resolve();

const app = express();

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.post("/webhook", upload.any(), async (req, res) => {
  const { timestamp, token, signature, from } = req.body as Record<
    string,
    string | undefined
  >;

  if (!verifySignature(timestamp ?? "", token ?? "", signature ?? "")) {
    res.status(401).send("invalid signature");
    return;
  }

  if (senderAddress(from ?? "") !== config.allowedSender) {
    console.log(`Ignoring email from unauthorized sender: ${from}`);
    res.status(200).send("ignored: sender not allowed");
    return;
  }

  const files = (req.files ?? []) as Express.Multer.File[];
  const pdfFile = files.find((f) => f.mimetype === "application/pdf");
  if (!pdfFile) {
    console.log("Ignoring email with no PDF attachment");
    res.status(200).send("ignored: no PDF attachment");
    return;
  }

  if (seenTokens.has(token!)) {
    res.status(200).send("duplicate delivery, already processed");
    return;
  }
  seenTokens.add(token!);
  if (seenTokens.size > SEEN_TOKENS_MAX) {
    seenTokens.delete(seenTokens.values().next().value!);
  }

  // Ack immediately — Mailgun times out waiting on Claude-length calls.
  // From here on, success/failure is only visible in the logs.
  res.status(200).send("accepted");

  const run = pipelineQueue.then(async () => {
    const images = await pdfToImages(pdfFile.buffer);
    console.log(`Rendered ${images.length} page(s), transcribing...`);
    const post = await transcribe(images);
    console.log(`Transcribed "${post.title}", publishing...`);
    return publish(post, images);
  });
  pipelineQueue = run.catch(() => {});

  try {
    const result = await run;
    if (result.skipped) {
      console.log(`Already published: ${result.postPath}`);
    } else {
      console.log(`Published: ${result.postPath}`);
    }
  } catch (error) {
    seenTokens.delete(token!);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Pipeline failed (re-send the email to retry): ${message}`);
  }
});

const server = await (async () => {
  console.log("Cloning/updating blog repo...");
  await initRepo();
  return app.listen(config.port, () => {
    console.log(`remarkable-blog listening on port ${config.port}`);
  });
})();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
