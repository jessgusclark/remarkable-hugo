import sharp from "sharp";

export async function trimTrailingWhitespace(image: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(image)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // reMarkable page templates (dot grid, ruled lines, etc.) print a faint,
  // regular pattern across the whole page, all the way to the bottom - a
  // per-row darkness check alone treats a row of grid dots as "content" and
  // stops there. The distinguishing feature is vertical extent: a single
  // grid dot or ruled line only spans a few rows, while actual handwriting
  // (letters, ascenders/descenders across a line of text) spans many
  // consecutive rows. So require a sustained run of dark rows, not just one.
  const darkThreshold = 200;
  const minDarkPixelsPerRow = Math.max(1, Math.round(width * 0.002));
  const minRunRows = Math.max(8, Math.round(height * 0.004));

  let lastContentRow = -1;
  let runStart = -1;
  let runLength = 0;
  for (let y = height - 1; y >= 0; y--) {
    const rowStart = y * width * channels;
    let darkCount = 0;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + x * channels;
      const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      if (brightness < darkThreshold && ++darkCount >= minDarkPixelsPerRow) break;
    }

    if (darkCount >= minDarkPixelsPerRow) {
      if (runLength === 0) runStart = y;
      runLength++;
      if (runLength >= minRunRows) {
        lastContentRow = runStart;
        break;
      }
    } else {
      runLength = 0;
    }
  }

  if (lastContentRow === -1) return image; // fully blank (or just template)

  const margin = Math.round(height * 0.02);
  const cropHeight = Math.min(height, lastContentRow + margin);
  if (cropHeight >= height * 0.98) return image; // negligible whitespace

  return sharp(image)
    .extract({ left: 0, top: 0, width, height: cropHeight })
    .toBuffer();
}
