# remarkable-blog

A microservice that converts handwritten reMarkable tablet pages into published Hugo blog posts.

Email a page from the reMarkable ("Send via email" as PDF), or a photo of a handwritten page, to a Mailgun-routed address. This service receives the Mailgun webhook, sends the attachment to Claude directly (PDF or image) to transcribe the handwriting, then renders page images from it, generates a Hugo post with the transcription and those page images, and pushes it to [jessgusclark/first-draft](https://github.com/jessgusclark/first-draft). GitHub Actions builds and deploys to [ashittyfirstdraft.xyz](https://ashittyfirstdraft.xyz).

## Setup

Requires Node 20+.

```sh
npm install
cp .env.example .env   # fill in every value
npm run build
npm start
```

On startup the service validates all required env vars, clones (or pulls) the blog repo into `blog-repo/`, and listens on `PORT`. `GET /health` returns 200.

### Environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |
| `MAILGUN_SIGNING_KEY` | Verifies inbound webhook signatures |
| `GITHUB_PAT` | Push access to the blog repo |
| `ALLOWED_SENDERS` | The address(es) your reMarkable sends from — a single address or an array of addresses; other senders are ignored |
| `BLOG_REPO_URL` | Blog repo clone URL |

**Breaking change:** `ALLOWED_SENDER` was renamed to `ALLOWED_SENDERS` (now accepts a single value or an array). Update `.env` on the server (and your local `.env` from `.env.example`) before deploying.
| `BLOG_REPO_BRANCH` | Branch to push to (default `main`) |
| `PORT` | Server port (default `3000`) |
| `REPO_DIR` | Local clone directory (default `./blog-repo`) |

### Mailgun route

Create an inbound route in Mailgun: match your chosen recipient (e.g. `match_recipient("post@yourdomain.com")`) and forward to `https://<your-host>/webhook`.

## Behavior notes

- The webhook acks immediately: a 200 means the email passed validation (signature, sender, supported attachment present) and was **accepted for processing** — the Claude transcription and git push happen in the background, so Mailgun never waits on them. If the background pipeline fails, the error is logged and the post is not published; re-send the email to retry.
- Duplicate protection: repeated deliveries of the same Mailgun token are skipped, and a post whose `content/posts/YYYY-MM-DD-slug.md` already exists in the repo is treated as already published.
- Supported attachments: the first attachment matching a PDF (`application/pdf`) or an image Claude's vision API accepts natively (`image/jpeg`, `image/png`, `image/gif`, `image/webp`) is used; anything else is ignored. The attachment is sent to Claude as-is — a PDF is not rasterized before transcription.
- Multi-page PDFs: all pages are transcribed in one Claude call (first line of page 1 is the title); page images are rendered afterward and saved as `slug-1.png`, `slug-2.png`, … Image attachments are single-page and saved as `slug.png` (normalized to PNG regardless of the original format).

## Testing without Mailgun

Simulate a signed Mailgun POST against a local server (uses the `MAILGUN_SIGNING_KEY` from your `.env`):

```sh
source .env
TS=$(date +%s)
TOKEN=$(uuidgen)
SIG=$(printf "%s%s" "$TS" "$TOKEN" | openssl dgst -sha256 -hmac "$MAILGUN_SIGNING_KEY" -hex | awk '{print $NF}')

curl -i http://localhost:3000/webhook \
  -F timestamp="$TS" \
  -F token="$TOKEN" \
  -F signature="$SIG" \
  -F from="Test <$ALLOWED_SENDER>" \
  -F subject="test" \
  -F "attachment-1=@page.pdf;type=application/pdf"
```

Expected: an immediate `accepted [200]`, then `Published: content/posts/YYYY-MM-DD-<title>.md` in the server logs, a new commit on the blog repo, and the post live after the Hugo deploy. Re-running the same command logs `Already published` with no second commit. A bad signature returns 401; a different `from` address returns `ignored`.

To test with a photo instead, swap the last line for `-F "attachment-1=@page.jpg;type=image/jpeg"` (also accepts `image/png`, `image/gif`, `image/webp`).
