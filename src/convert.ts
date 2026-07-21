import Anthropic from "@anthropic-ai/sdk";
import { pdf } from "pdf-to-img";
import { config } from "./config.js";

const SYSTEM_PROMPT = `You are converting a handwritten blog post into text for publication.

Rules:
- The first line of handwriting is the post title. Everything after is the body.
- Transcribe exactly what is written. Do not correct grammar, spelling, or punctuation.
- If a word is crossed out or scribbled over, skip it entirely.
- Preserve paragraph breaks where the author clearly left space between sections.
- Do not add any formatting (bold, italic, headers) unless the author explicitly indicated it.
- If a word is truly illegible, insert [illegible] rather than guessing.
- Do not add anything the author did not write. No introductions, no sign-offs, no corrections.

Respond with JSON only. No preamble, no markdown fences.

{"title": "the post title as written", "body": "the full post body with paragraph breaks as newlines"}`;

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface TranscribedPost {
  title: string;
  body: string;
}

export async function pdfToImages(pdfBuffer: Buffer): Promise<Buffer[]> {
  const document = await pdf(pdfBuffer, { scale: 2 });
  const images: Buffer[] = [];
  for await (const page of document) {
    images.push(page);
  }
  if (images.length === 0) {
    throw new Error("PDF contained no pages");
  }
  return images;
}

// All pages go in one request: the system prompt defines the first line of
// handwriting as the title, which only holds across the whole document.
export async function transcribe(images: Buffer[]): Promise<TranscribedPost> {
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["title", "body"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: "user",
        content: [
          ...images.map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: "image/png" as const,
              data: image.toString("base64"),
            },
          })),
          { type: "text" as const, text: "Convert this handwritten post." },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude refused to transcribe the page");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Transcription truncated: hit max_tokens");
  }

  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) {
    throw new Error("No text content in Claude response");
  }

  const parsed = JSON.parse(text) as TranscribedPost;
  if (!parsed.title.trim()) {
    throw new Error("Transcription produced an empty title");
  }
  return parsed;
}
