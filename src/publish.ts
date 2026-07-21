import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { config } from "./config.js";
import type { TranscribedPost } from "./convert.js";

const GIT_AUTHOR_NAME = "remarkable-blog";
const GIT_AUTHOR_EMAIL = "remarkable-blog@ashittyfirstdraft.xyz";

function authenticatedRepoUrl(): string {
  const url = new URL(config.blogRepoUrl);
  url.username = "x-access-token";
  url.password = config.githubPat;
  return url.toString();
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

let git: SimpleGit;

export async function initRepo(): Promise<void> {
  const repoDir = path.resolve(config.repoDir);
  const isCloned = await fs
    .access(path.join(repoDir, ".git"))
    .then(() => true)
    .catch(() => false);

  if (!isCloned) {
    await simpleGit().clone(authenticatedRepoUrl(), repoDir, [
      "--branch",
      config.blogRepoBranch,
    ]);
  }

  git = simpleGit(repoDir);
  await git.addConfig("user.name", GIT_AUTHOR_NAME);
  await git.addConfig("user.email", GIT_AUTHOR_EMAIL);
  // Keep the remote authenticated even if the clone predates this process
  // or the PAT has rotated since.
  await git.remote(["set-url", "origin", authenticatedRepoUrl()]);
  if (isCloned) {
    await git.pull("origin", config.blogRepoBranch);
  }
}

export interface PublishResult {
  postPath: string;
  skipped: boolean;
}

export async function publish(
  post: TranscribedPost,
  images: Buffer[],
): Promise<PublishResult> {
  const repoDir = path.resolve(config.repoDir);
  await git.pull("origin", config.blogRepoBranch);

  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10);
  const timestamp = `${now.toISOString().slice(0, 19)}+00:00`;
  const baseName = `${dateStamp}-${slugify(post.title)}`;
  const postRelPath = path.posix.join("content", "posts", `${baseName}.md`);

  // Same title on the same day: treat as a duplicate delivery (Mailgun retry
  // after a timeout) and skip rather than overwrite.
  const alreadyPublished = await fs
    .access(path.join(repoDir, postRelPath))
    .then(() => true)
    .catch(() => false);
  if (alreadyPublished) {
    return { postPath: postRelPath, skipped: true };
  }

  const imageNames =
    images.length === 1
      ? [`${baseName}.png`]
      : images.map((_, i) => `${baseName}-${i + 1}.png`);

  await fs.mkdir(path.join(repoDir, "static", "images"), { recursive: true });
  const imageRelPaths: string[] = [];
  for (const [i, image] of images.entries()) {
    const relPath = path.posix.join("static", "images", imageNames[i]);
    await fs.writeFile(path.join(repoDir, relPath), image);
    imageRelPaths.push(relPath);
  }

  const imageMarkdown = imageNames
    .map((name) => `![handwritten page](/images/${name})`)
    .join("\n");
  const markdown = `---
title: "${post.title.replace(/"/g, '\\"')}"
date: ${timestamp}
tags:
  - handwritten
draft: false
---

${imageMarkdown}

${post.body.trim()}
`;

  await fs.writeFile(path.join(repoDir, postRelPath), markdown);

  await git.add([postRelPath, ...imageRelPaths]);
  await git.commit(`New post: ${post.title}`);
  try {
    await git.push("origin", config.blogRepoBranch);
  } catch {
    // Remote moved since our pull: rebase our commit on top and retry once.
    await git.pull("origin", config.blogRepoBranch, { "--rebase": null });
    await git.push("origin", config.blogRepoBranch);
  }

  return { postPath: postRelPath, skipped: false };
}
