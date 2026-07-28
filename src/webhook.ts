import express from "express";
import multer from "multer";
import { config } from "./config.js";
import { pdfToImages, transcribe } from "./convert.js";
import { publish } from "./publish.js";
import { verifySignature } from "./signature.js";

const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const SEEN_TOKENS_MAX = 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
});

function senderAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

// Tokens of deliveries we've already accepted, so a Mailgun retry (e.g. after
// the forward timed out mid-pipeline) doesn't publish a duplicate.
const seenTokens = new Set<string>();

// One pipeline run at a time: concurrent runs would race the git working tree.
let pipelineQueue: Promise<unknown> = Promise.resolve();

export const webhookRouter = express.Router();

webhookRouter.post("/webhook", upload.any(), async (req, res) => {
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
