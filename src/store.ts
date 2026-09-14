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
 * Serialises every write. `git.add` + `git.commit` share one on-disk index and
 * one HEAD, so concurrent writes each report a commit id while all but the last
 * are left dangling — reachable by id today, gone after the next gc, and absent
 * from page_history all along. Open WebUI runs one turn's tools sequentially, so
 * this needs two chats at once; that is a normal state for a shared instance.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  // Keep the chain alive regardless of outcome; callers see their own rejection.
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Names that must never become pages, because they are routes on this server.
 *
 * Without this a page called "mcp" is served at GET /mcp — the tool endpoint's
 * own path — which is model-authored HTML on a URL people are told to trust.
 * POST /mcp still reaches the real handler, so this is confusion and a phishing
 * surface rather than a compromise, but it should simply not be possible.
 */
const RESERVED_SLUGS = new Set([
  "mcp",
  "healthz",
  "s",
  "approve",
  "robots.txt",
  "index",
  "favicon",
]);

/** Slugs become filenames and URL paths, so they are tightly constrained. */
export function isValidSlug(slug: string): boolean {
  if (RESERVED_SLUGS.has(slug)) return false;
  return /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(slug);
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/**
 * Every filesystem path is built here, so validation belongs here rather than in
 * a handler. It was previously only in write_page, which left read_page,
 * share_page, delete_page and four others able to traverse: a slug of
 * "../outside" resolved to a file outside the data directory and was read back.
 */
function assertSlug(slug: string): void {
  if (!isValidSlug(slug)) {
    throw new Error(
      `Refused: "${slug}" is not a valid page name. Use lowercase letters, digits and hyphens, 2-64 characters.`,
    );
  }
}

const pagePath = (slug: string) => {
  assertSlug(slug);
  return path.join(config.pagesDir, `${slug}.html`);
};

/**
 * Refuses to start on a volume that did not attach.
 *
 * The Dockerfile creates /data/pages in the IMAGE, because that is what gives
 * the volume `node` ownership on first mount — which means a missing volume is
 * indistinguishable from a first boot. initRepo would see an empty directory,
 * git.init a fresh history over the top, and report healthy, with every page
 * gone. Silently initialising an empty history is the least recoverable thing
 * this service does, so it checks the mount table rather than the directory.
 */
async function assertVolumeMounted(): Promise<void> {
  if (!config.requireMount) return;
  const mountinfo = await fs
    .readFile("/proc/self/mountinfo", "utf8")
    .catch(() => "");
  // Field 5 is the mount point. An empty read means no procfs, which is not
  // the container this check exists for.
  if (!mountinfo) return;
  const target = path.dirname(config.pagesDir);
  const mounted = mountinfo
    .split("\n")
    .some((line) => line.split(" ")[4] === target);
  if (!mounted) {
    throw new Error(
      `FATAL: ${target} is not a mount point — the pages volume did not attach. Refusing to start a new, empty history over it.`,
    );
  }
}

export async function initRepo(): Promise<void> {
  await assertVolumeMounted();
  await fs.mkdir(config.pagesDir, { recursive: true });
  const gitdir = path.join(config.pagesDir, ".git");
  try {
    await fs.access(gitdir);
  } catch {
    await git.init({ fs, dir: config.pagesDir, defaultBranch: "main" });
    console.log(`[store] initialised a new page repo at ${config.pagesDir}`);
  }
}

/**
 * What /healthz asks the disk, rather than asserting from memory.
 *
 * The page count is the volume-loss canary: it dropping to zero is the signal
 * you want, and a plain {status:true} cannot give it. The probe write catches a
 * read-only remount, a full disk, and a restore done with the wrong ownership —
 * none of which the old health check could see.
 */
export async function storeHealth(): Promise<{
  pages: number;
  head: string;
}> {
  const head = (
    await fs.readFile(path.join(config.pagesDir, ".git/HEAD"), "utf8")
  ).trim();
  // Not named *.html, so listPages ignores it; and git.commit commits the index
  // rather than the worktree, so it can never land in a revision.
  const probe = path.join(config.pagesDir, ".healthz");
  await fs.writeFile(probe, String(Date.now()));
  await fs.unlink(probe);
  const pages = (await fs.readdir(config.pagesDir)).filter((f) =>
    f.endsWith(".html"),
  ).length;
  return { pages, head };
}

export async function listPages() {
  const entries = await fs.readdir(config.pagesDir).catch(() => []);
  const pages = [];

  for (const entry of entries) {
    // A .meta.json never ends in .html, so the extension test alone is enough.
    if (!entry.endsWith(".html")) continue;
    const slug = entry.slice(0, -".html".length);
    // Names come from the filesystem here, not from the validator, so a file
    // placed by hand or restored from a backup could carry anything.
    if (!isValidSlug(slug)) continue;
    const stat = await fs.stat(path.join(config.pagesDir, entry));
    const meta = await getMeta(slug);
    pages.push({
      slug,
      visibility: meta.visibility,
      url: urlFor(slug, meta),
      bytes: stat.size,
      updated: stat.mtime.toISOString(),
      lastMessage: meta.lastMessage ?? null,
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
  return serialise(async () => {
  await fs.writeFile(pagePath(slug), html, "utf8");
  await git.add({ fs, dir: config.pagesDir, filepath: `${slug}.html` });

  // Ensure the page has metadata before committing, so a new page is recorded as
  // private in the same revision that creates it — never a window where content
  // exists with no visibility decision attached.
  const note = message || `Update ${slug}`;
  const meta = { ...(await getMeta(slug)), lastMessage: note };
  await setMeta(slug, meta);

  const commit = await git.commit({
    fs,
    dir: config.pagesDir,
    message: note,
    author,
  });

  return {
    slug,
    visibility: meta.visibility,
    url: urlFor(slug, meta),
    commit: commit.slice(0, 8),
    bytes: Buffer.byteLength(html, "utf8"),
  };
  });
}

/** Change who can reach a page. Recorded as its own revision. */
export async function setVisibility(
  slug: string,
  next: PageMeta,
  message: string,
): Promise<{ slug: string; visibility: string; url: string | null; commit: string }> {
  assertSlug(slug);
  return serialise(async () => {
  await fs.access(pagePath(slug));
  // next is built from scratch by the caller (dropping shareId is how a page is
  // unshared), so the cached note has to be carried across explicitly.
  const carried = { lastMessage: (await getMeta(slug)).lastMessage, ...next };
  await setMeta(slug, carried);
  const commit = await git.commit({
    fs,
    dir: config.pagesDir,
    message,
    author,
  });
  return {
    slug,
    visibility: carried.visibility,
    url: urlFor(slug, carried),
    commit: commit.slice(0, 8),
  };
  });
}

/**
 * Revisions of both the content and who could reach it, merged into one
 * timeline — "what did this say" and "who could see it" are the same question
 * when the page is shared.
 */
export async function pageHistory(slug: string, depth: number) {
  assertSlug(slug);
  const [content, access] = await Promise.all([
    // force: true is what makes a DELETED page's history readable. Without it
    // git.log throws NotFoundError when the path is absent from HEAD's tree, the
    // catch swallowed it, and page_history returned [] - so delete_page's
    // promise that "restore_page can bring it back" was unwalkable.
    git.log({ fs, dir: config.pagesDir, filepath: `${slug}.html`, depth, force: true }).catch(() => []),
    git.log({ fs, dir: config.pagesDir, filepath: metaFile(slug), depth, force: true }).catch(() => []),
  ]);

  // Order by git's own walk, NOT by timestamp. Timestamps are second-resolution,
  // so a create followed by a share - the common case within one model turn -
  // ties, and a stable sort then leaves the older commit first in a list
  // documented newest-first. The walk is authoritative on a linear history.
  const walk = await git
    .log({ fs, dir: config.pagesDir, depth: depth * 4 })
    .catch(() => []);
  const rank = new Map(walk.map((c, i) => [c.oid, i]));

  const seen = new Set<string>();
  return [...content, ...access]
    .filter((entry) => (seen.has(entry.oid) ? false : seen.add(entry.oid)))
    .sort(
      (a, b) =>
        (rank.get(a.oid) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.oid) ?? Number.MAX_SAFE_INTEGER),
    )
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
  assertSlug(slug);
  // Let expandOid throw: swallowing AmbiguousError turned "that prefix matches
  // several commits" into "could not find it", which is the wrong diagnosis.
  const oid = await git.expandOid({ fs, dir: config.pagesDir, oid: commit });

  // Every commit carries a whole tree, so reading a blob at this path would
  // succeed for a commit that never touched THIS page. Require the commit to be
  // one of the page's own revisions.
  const own = await git
    .log({ fs, dir: config.pagesDir, filepath: `${slug}.html`, force: true })
    .catch(() => []);
  if (!own.some((entry) => entry.oid === oid)) {
    throw new Error(
      `Refused: ${commit} is not a revision of "${slug}". Use page_history to list its revisions.`,
    );
  }

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
  return serialise(async () => {
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
  });
}
