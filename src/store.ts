/**
 * A git-backed store for shared HTML pages.
 *
 * Why git rather than a table with a `version` column: history, diffs, rollback
 * and "who changed what when" all come free and are inspectable with ordinary
 * tools. If this service ever dies, the pages are still a directory of HTML files
 * with a git log next to them — recoverable without this code.
 *
 * isomorphic-git rather than shelling out to `git`: no git binary in the image,
 * no argument-injection surface from model-supplied slugs and messages.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import git from "isomorphic-git";

import { config } from "./config.js";

const author = { name: "Open WebUI", email: "chat@vps.local" };

/** Slugs become filenames and URL paths, so they are tightly constrained. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(slug);
}

const pagePath = (slug: string) => path.join(config.pagesDir, `${slug}.html`);

export async function initRepo(): Promise<void> {
  await fs.mkdir(config.pagesDir, { recursive: true });
  const gitdir = path.join(config.pagesDir, ".git");
  try {
    await fs.access(gitdir);
  } catch {
    await git.init({ fs, dir: config.pagesDir, defaultBranch: "main" });
    console.log(`[store] initialised a new page repo at ${config.pagesDir}`);
  }
}

export async function listPages() {
  const entries = await fs.readdir(config.pagesDir).catch(() => []);
  const pages = [];

  for (const entry of entries) {
    if (!entry.endsWith(".html")) continue;
    const slug = entry.slice(0, -".html".length);
    const stat = await fs.stat(path.join(config.pagesDir, entry));
    const history = await git
      .log({ fs, dir: config.pagesDir, filepath: entry, depth: 1 })
      .catch(() => []);

    pages.push({
      slug,
      url: `${config.publicBase}/${slug}`,
      bytes: stat.size,
      updated: stat.mtime.toISOString(),
      revisions: history.length ? undefined : 0,
      lastMessage: history[0]?.commit.message.trim() ?? null,
    });
  }

  return pages.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function readPage(slug: string): Promise<string> {
  return fs.readFile(pagePath(slug), "utf8");
}

export async function writePage(
  slug: string,
  html: string,
  message: string,
): Promise<{ slug: string; url: string; commit: string; bytes: number }> {
  await fs.writeFile(pagePath(slug), html, "utf8");
  await git.add({ fs, dir: config.pagesDir, filepath: `${slug}.html` });
  const commit = await git.commit({
    fs,
    dir: config.pagesDir,
    message: message || `Update ${slug}`,
    author,
  });

  return {
    slug,
    url: `${config.publicBase}/${slug}`,
    commit: commit.slice(0, 8),
    bytes: Buffer.byteLength(html, "utf8"),
  };
}

export async function pageHistory(slug: string, depth: number) {
  const log = await git.log({
    fs,
    dir: config.pagesDir,
    filepath: `${slug}.html`,
    depth,
  });

  return log.map((entry) => ({
    commit: entry.oid.slice(0, 8),
    message: entry.commit.message.trim(),
    when: new Date(entry.commit.author.timestamp * 1000).toISOString(),
  }));
}

/**
 * The content of a page as it was at a given commit.
 *
 * page_history returns short ids because they are what a human reads, but
 * readBlob will not resolve an abbreviated oid — it answers "Could not find
 * <id>". Expand it first so the id the model was given is the id it can use.
 */
export async function readRevision(
  slug: string,
  commit: string,
): Promise<string> {
  const oid = await git
    .expandOid({ fs, dir: config.pagesDir, oid: commit })
    .catch(() => commit);

  const { blob } = await git.readBlob({
    fs,
    dir: config.pagesDir,
    oid,
    filepath: `${slug}.html`,
  });
  return Buffer.from(blob).toString("utf8");
}

/**
 * Restore an earlier revision as a NEW commit rather than moving the branch.
 * Rolling back is itself a change worth recording — the history stays linear and
 * nothing is lost.
 */
export async function revertPage(
  slug: string,
  commit: string,
): Promise<{
  slug: string;
  url: string;
  commit: string;
  restoredFrom: string;
}> {
  const previous = await readRevision(slug, commit);
  const result = await writePage(
    slug,
    previous,
    `Restore ${slug} to ${commit.slice(0, 8)}`,
  );
  return { ...result, restoredFrom: commit.slice(0, 8) };
}

export async function deletePage(
  slug: string,
  message: string,
): Promise<string> {
  await fs.unlink(pagePath(slug));
  await git.remove({ fs, dir: config.pagesDir, filepath: `${slug}.html` });
  const commit = await git.commit({
    fs,
    dir: config.pagesDir,
    message: message || `Delete ${slug}`,
    author,
  });
  // The file is gone from the working tree but every revision remains in the
  // history, so a delete is recoverable with restore_page.
  return commit.slice(0, 8);
}
