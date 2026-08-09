import Anthropic from "@anthropic-ai/sdk";
import { pdf } from "pdf-to-img";
import sharp from "sharp";
import { config } from "./config.js";
import { extractTags } from "./tags.js";

const SYSTEM_PROMPT = `You are converting a handwritten blog post into text for publication.

Rules:
- The first line of handwriting is the post title. Everything after is the body.
- Transcribe exactly what is written. Do not correct grammar, spelling, or punctuation.
- If a word is crossed out or scribbled over, skip it entirely.
- Preserve paragraph breaks where the author clearly left space between sections.
- Do not add any formatting (bold, italic, headers) unless the author explicitly indicated it (underline = italic, all caps = keep as all caps).
- If a word is truly illegible, insert [illegible] rather than guessing.
- Do not add anything the author did not write. No introductions, no sign-offs, no corrections.

Respond with JSON only. No preamble, no markdown fences.

{"title": "the post title as written, without #", "body": "the full post body with paragraph breaks as newlines"}`;

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export interface TranscribedPost {
  title: string;
  body: string;
  tags: string[];
}

export interface Attachment {
  buffer: Buffer;
  mimetype: string;
}

const PDF_MIME_TYPE = "application/pdf" as const;

// The image media types Claude's vision API accepts natively.
const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;
type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export const SUPPORTED_MIME_TYPES = new Set<string>([
  PDF_MIME_TYPE,
  ...SUPPORTED_IMAGE_MIME_TYPES,
]);

function isSupportedImageMimeType(
  mimetype: string
): mimetype is SupportedImageMimeType {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimetype);
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

// The attachment is sent to Claude as-is (native PDF document or image, not
// rasterized), so Claude reads the whole document in one request: the system
// prompt defines the first line of handwriting as the title, which only
// holds across the whole document.
export async function transcribe(
  attachment: Attachment
): Promise<TranscribedPost> {
  const contentBlock =
    attachment.mimetype === PDF_MIME_TYPE
      ? {
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: PDF_MIME_TYPE,
            data: attachment.buffer.toString("base64"),
          },
        }
      : (() => {
          if (!isSupportedImageMimeType(attachment.mimetype)) {
            throw new Error(
              `Unsupported attachment type: ${attachment.mimetype}`
            );
          }
          return {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: attachment.mimetype,
              data: attachment.buffer.toString("base64"),
            },
          };
        })();

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
          contentBlock,
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

  const parsed = JSON.parse(text) as Omit<TranscribedPost, "tags">;
  if (!parsed.title.trim()) {
    throw new Error("Transcription produced an empty title");
  }
  const { body, tags } = extractTags(parsed.body);
  return { title: parsed.title, body, tags };
}

// Rasterize the attachment into the page image(s) used for publishing. This
// happens after transcription, not before, so Claude always sees the
// original file rather than an inflated re-encoding of it.
export async function attachmentToPageImages(
  attachment: Attachment
): Promise<Buffer[]> {
  if (attachment.mimetype === PDF_MIME_TYPE) {
    return pdfToImages(attachment.buffer);
  }
  const png = await sharp(attachment.buffer).png().toBuffer();
  return [png];
}
