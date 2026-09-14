/**
 * Configuration, and the vault fetch that supplies this service's bearer.
 *
 * Same shape as bridge-mcp deliberately: one pattern for every service on this
 * box, so there is one thing to learn and one place each failure mode lives.
 */

const env = (key: string, fallback?: string): string => {
  const value = process.env[key];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`FATAL: ${key} is not set`);
  }
  return value;
};

export const config = {
  port: Number(env("PORT", "3013")),

  /** Where the git repo of pages lives. A docker volume, so it survives deploys. */
  pagesDir: env("PAGES_DIR", "/data/pages"),

  /** Used to build the shareable URL returned to the model. */
  publicBase: env("PUBLIC_BASE", "https://pages.vps.sarvinshrivastava.space"),

  vault: {
    url: env("SECRETS_MANAGER_URL", "http://secret-manager:8000"),
    folder: env("SECRETS_MANAGER_FOLDER", "Root"),
    token: process.env.SECRETS_MANAGER_TOKEN ?? "",
  },

  limits: {
    // A page is a document, not a bundle. Large enough for a real report with
    // inline CSS, small enough that the model cannot fill the disk or the
    // context window with one call.
    maxPageBytes: 512 * 1024,
    maxHistoryDepth: 50,
    httpTimeoutMs: 15_000,
  },
};

/** See bridge-mcp's config.ts — same reasoning, same two failure modes handled. */
export function parseVaultBody(text: string, label: string): string {
  const docs: Array<{ value?: unknown }> = [];
  let depth = 0;
  let startIdx = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && startIdx >= 0) {
        try {
          docs.push(JSON.parse(text.slice(startIdx, i + 1)));
        } catch {
          /* not valid JSON on its own */
        }
        startIdx = -1;
      }
    }
  }

  const value = docs.at(-1)?.value;
  if (typeof value !== "string" || value === "") {
    throw new Error(`FATAL: vault returned no usable value for ${label}`);
  }
  return value;
}

export async function vaultFetch(key: string): Promise<string> {
  if (!config.vault.token)
    throw new Error("FATAL: SECRETS_MANAGER_TOKEN is empty");

  const label = `${config.vault.folder}/${key}`;
  const attempts = 4;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(
        `${config.vault.url}/api/secrets/${config.vault.folder}/${key}`,
        {
          headers: { Authorization: `Bearer ${config.vault.token}` },
          signal: AbortSignal.timeout(config.limits.httpTimeoutMs),
          redirect: "error",
        },
      );
    } catch (error) {
      const cause =
        error instanceof Error && error.cause instanceof Error
          ? `: ${error.cause.message}`
          : "";
      if (attempt === attempts)
        throw new Error(`FATAL: vault unreachable for ${label}${cause}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }

    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new Error(`FATAL: vault returned HTTP ${res.status} for ${label}`);
    }
    if (!res.ok) {
      if (attempt === attempts)
        throw new Error(
          `FATAL: vault returned HTTP ${res.status} for ${label}`,
        );
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }

    return parseVaultBody(await res.text(), label);
  }

  throw new Error(`FATAL: vault unreachable for ${label}`);
}
