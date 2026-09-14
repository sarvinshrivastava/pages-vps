/**
 * Per-page visibility, versioned alongside the pages themselves.
 *
 * Three levels, matching how a shared artifact actually gets used:
 *
 *   private  not served over HTTP at all. Readable only through the tools.
 *            The default, because a page should not become reachable by
 *            existing — sharing is a decision.
 *   shared   served at /s/<shareId> with an unguessable id. Anyone with the
 *            link can read it; nobody can find it without the link, and it is
 *            never listed.
 *   public   served at /<slug> and listed on the index. A real URL you can say
 *            out loud.
 *
 * The metadata lives in a committed file rather than a database, so visibility
 * changes are themselves revisions: "when did this become public, and who made
 * it so" is answerable from the same history as the content.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import git from "isomorphic-git";

import { config } from "./config.js";

export type Visibility = "private" | "shared" | "public";

export type PageMeta = {
  visibility: Visibility;
  /** Present only while the page is shared; rotating it revokes old links. */
  shareId?: string;
};

/**
 * One metadata file PER PAGE, not one shared file.
 *
 * A single pages.json would be simpler, but then `git log <slug>.html` misses
 * every visibility change, and a shared file's history is a stream of unrelated
 * pages. Per-page files let one history answer both "what did this page say" and
 * "who could reach it" — which is the point of versioning the sharing state.
 */
export const metaFile = (slug: string) => `${slug}.meta.json`;
const metaPath = (slug: string) => {
  // Same reasoning as store.ts: the path boundary is the only place a slug check
  // cannot be forgotten by a new caller.
  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(slug)) {
    throw new Error(`Refused: "${slug}" is not a valid page name.`);
  }
  return path.join(config.pagesDir, metaFile(slug));
};

export async function getMeta(slug: string): Promise<PageMeta> {
  try {
    return JSON.parse(await fs.readFile(metaPath(slug), "utf8")) as PageMeta;
  } catch {
    // Unknown pages are private. A page whose metadata predates this, or was
    // lost, must not default to being readable by the internet.
    return { visibility: "private" };
  }
}

/**
 * Writes metadata and stages it. The caller commits, so a content change and its
 * visibility change land in ONE revision rather than two — otherwise history
 * shows a page briefly public before its content existed.
 */
export async function setMeta(slug: string, next: PageMeta): Promise<PageMeta> {
  await fs.writeFile(metaPath(slug), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await git.add({ fs, dir: config.pagesDir, filepath: metaFile(slug) });
  return next;
}

export async function removeMeta(slug: string): Promise<void> {
  await fs.unlink(metaPath(slug)).catch(() => undefined);
  await git.remove({ fs, dir: config.pagesDir, filepath: metaFile(slug) }).catch(() => undefined);
}

/** 16 bytes: long enough that guessing is not a strategy. */
export const newShareId = (): string => crypto.randomBytes(16).toString("hex");

export function urlFor(slug: string, meta: PageMeta): string | null {
  if (meta.visibility === "public") return `${config.publicBase}/${slug}`;
  if (meta.visibility === "shared" && meta.shareId) {
    return `${config.publicBase}/s/${meta.shareId}`;
  }
  return null;
}

/** Reverse lookup for the /s/<id> route. Linear, but the page count is small. */
export async function slugForShareId(shareId: string): Promise<string | null> {
  const entries = await fs.readdir(config.pagesDir).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".meta.json")) continue;
    const slug = entry.slice(0, -".meta.json".length);
    const meta = await getMeta(slug);
    if (meta.visibility === "shared" && meta.shareId === shareId) return slug;
  }
  return null;
}
