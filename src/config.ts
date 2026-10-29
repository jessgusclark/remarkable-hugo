import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  mailgunSigningKey: required("MAILGUN_SIGNING_KEY"),
  githubPat: required("GITHUB_PAT"),
  blogRepoUrl: required("BLOG_REPO_URL"),
  allowedSender: required("ALLOWED_SENDER").toLowerCase(),
  blogRepoBranch: process.env.BLOG_REPO_BRANCH ?? "main",
  // Loopback only behind nginx on the droplet. Railway's proxy needs all
  // interfaces; drop that fallback once Railway is gone.
  host:
    process.env.HOST ??
    (process.env.RAILWAY_ENVIRONMENT_NAME ? "0.0.0.0" : "127.0.0.1"),
  port: Number(process.env.PORT ?? 3000),
  repoDir: process.env.REPO_DIR ?? "./blog-repo",
};
