// Every whitespace/comma-separated token on the line must start with "#",
// so a line that merely ends in a stray "#" (or is ordinary prose) isn't
// misdetected as a tag line.
const TAG_LINE_PATTERN = /^(#\S+[\s,]*)+$/;

export function extractTags(body: string): { body: string; tags: string[] } {
  const lines = body.split("\n");

  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx].trim() === "") lastIdx--;
  if (lastIdx < 0) return { body, tags: [] };

  const lastLine = lines[lastIdx].trim();
  if (!TAG_LINE_PATTERN.test(lastLine)) return { body, tags: [] };

  const tags = lastLine
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => token.replace(/^#/, "").trim().toLowerCase())
    .filter(Boolean);

  const remainingBody = lines.slice(0, lastIdx).join("\n").trimEnd();
  return { body: remainingBody, tags };
}
