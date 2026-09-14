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

  /**
   * Refuse to boot if PAGES_DIR's parent is not a mount point. On by default —
   * turn it off only for a local run outside a container.
   */
  requireMount: (process.env.REQUIRE_MOUNT ?? "1") !== "0",

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

/** Extracts the value from a vault response. */
export function parseVaultBody(text: string, label: string): string {
  // Deliberately a plain parse. The bash sibling slurps concatenated documents
  // because curl cannot rewind a pipe on --retry and glues a failed body in
  // front of the good one. `fetch` has no such failure mode: every attempt is a
  // fresh response and text() reads exactly one body. The hand-rolled scanner
  // that used to live here also swallowed malformed JSON, which is worse than
  // failing on it.
  let parsed: { value?: unknown };
  try {
    parsed = JSON.parse(text) as { value?: unknown };
  } catch {
    throw new Error(`FATAL: vault returned unparseable JSON for ${label}`);
  }

  // An empty string is a failure, not a value: it would configure this service
  // with blank credentials that only fail later, at call time.
  if (typeof parsed.value !== "string" || parsed.value === "") {
    throw new Error(`FATAL: vault returned no usable value for ${label}`);
  }
  return parsed.value;
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
