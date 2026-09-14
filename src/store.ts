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
import { getMeta, setMeta, removeMeta, urlFor, metaFile, type PageMeta } from "./meta.js";

const author = { name: "Open WebUI", email: "chat@vps.local" };

/**
 * Names that must never become pages, because they are routes on this server.
 *
 * Without this a page called "mcp" is served at GET /mcp — the tool endpoint's
 * own path — which is model-authored HTML on a URL people are told to trust.
 * POST /mcp still reaches the real handler, so this is confusion and a phishing
 * surface rather than a compromise, but it should simply not be possible.
 */
const RESERVED_SLUGS = new Set(["mcp", "healthz", "s", "index", "favicon"]);

/** Slugs become filenames and URL paths, so they are tightly constrained. */
export function isValidSlug(slug: string): boolean {
  if (RESERVED_SLUGS.has(slug)) return false;
  return /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(slug);
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
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
    if (!entry.endsWith(".html") || entry.endsWith(".meta.json")) continue;
    const slug = entry.slice(0, -".html".length);
    const stat = await fs.stat(path.join(config.pagesDir, entry));
    const history = await git
      .log({ fs, dir: config.pagesDir, filepath: entry, depth: 1 })
      .catch(() => []);

    const meta = await getMeta(slug);
    pages.push({
      slug,
      visibility: meta.visibility,
      url: urlFor(slug, meta),
      bytes: stat.size,
      updated: stat.mtime.toISOString(),
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
): Promise<{
  slug: string;
  visibility: string;
  url: string | null;
  commit: string;
  bytes: number;
}> {
  await fs.writeFile(pagePath(slug), html, "utf8");
  await git.add({ fs, dir: config.pagesDir, filepath: `${slug}.html` });

  // Ensure the page has metadata before committing, so a new page is recorded as
  // private in the same revision that creates it — never a window where content
  // exists with no visibility decision attached.
  const meta = await getMeta(slug);
  await setMeta(slug, meta);

  const commit = await git.commit({
    fs,
    dir: config.pagesDir,
    message: message || `Update ${slug}`,
    author,
  });

  return {
    slug,
    visibility: meta.visibility,
    url: urlFor(slug, meta),
    commit: commit.slice(0, 8),
    bytes: Buffer.byteLength(html, "utf8"),
  };
}

/** Change who can reach a page. Recorded as its own revision. */
export async function setVisibility(
  slug: string,
  next: PageMeta,
  message: string,
): Promise<{ slug: string; visibility: string; url: string | null; commit: string }> {
  await fs.access(pagePath(slug));
  await setMeta(slug, next);
  const commit = await git.commit({
    fs,
    dir: config.pagesDir,
    message,
    author,
  });
  return {
    slug,
    visibility: next.visibility,
    url: urlFor(slug, next),
    commit: commit.slice(0, 8),
  };
}

/**
 * Revisions of both the content and who could reach it, merged into one
 * timeline — "what did this say" and "who could see it" are the same question
 * when the page is shared.
 */
export async function pageHistory(slug: string, depth: number) {
  const [content, access] = await Promise.all([
    git.log({ fs, dir: config.pagesDir, filepath: `${slug}.html`, depth }).catch(() => []),
    git.log({ fs, dir: config.pagesDir, filepath: metaFile(slug), depth }).catch(() => []),
  ]);

  // Git timestamps have one-second resolution, so commits made within the same
  // second tie and keep their concatenation order. Only visible when changes land
  // back-to-back; real edits minutes apart sort correctly.
  const seen = new Set<string>();
  return [...content, ...access]
    .filter((entry) => (seen.has(entry.oid) ? false : seen.add(entry.oid)))
    .sort((a, b) => b.commit.author.timestamp - a.commit.author.timestamp)
    .slice(0, depth)
    .map((entry) => ({
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
  visibility: string;
  url: string | null;
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
  // Drop the visibility entry too, so a restored page comes back private rather
  // than silently regaining a share link that was handed out before.
  await removeMeta(slug);
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
