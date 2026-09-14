/**
 * Human approval for putting a page on the public web.
 *
 * Everything else in this service is a decision the model can make on its own,
 * because everything else is reversible and unlisted. Going public is neither:
 * the page gets a guessable URL, lands on the index, and — whatever this service
 * does afterwards — anything that fetched it in the meantime keeps its copy.
 *
 * The gate has to be genuinely out of band or it is theatre. A "confirm: true"
 * argument, or a token returned to the model to send back, is something the
 * model can satisfy by itself in the same turn; a document carrying injected
 * instructions would satisfy it just as easily. So the approval token is never
 * returned to the model. It goes to a push notification on the owner's phone,
 * and the only way to spend it is to open the link and press the button.
 *
 * Held in memory on purpose: a restart drops every pending request, which fails
 * closed. A request nobody approved within the window should expire anyway.
 */

import crypto from "node:crypto";

import { config } from "./config.js";

type Pending = {
  slug: string;
  createdAt: number;
};

const pending = new Map<string, Pending>();

const TTL_MS = 15 * 60 * 1000;

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [token, entry] of pending) {
    if (entry.createdAt < cutoff) pending.delete(token);
  }
}

/**
 * Creates a request and pushes the link. Returns nothing the caller could use to
 * approve it — deliberately, since the caller is the model.
 */
export async function requestPublication(slug: string): Promise<void> {
  if (!config.approvals.notifyUrl) {
    throw new Error(
      'Refused: publishing needs an approval channel, and none is configured. Set PAGES_NTFY_URL in the vault. The page can still be shared with a secret link — use visibility "shared".',
    );
  }

  sweep();
  // Same 16 bytes as a share id: this is a bearer credential for one action.
  const token = crypto.randomBytes(16).toString("hex");
  pending.set(token, { slug, createdAt: Date.now() });

  const url = `${config.publicBase}/approve/${token}`;
  const res = await fetch(config.approvals.notifyUrl, {
    method: "POST",
    headers: {
      Title: "Approve publishing a page",
      Priority: "high",
      Tags: "warning",
      // Open the review page rather than approving from the notification: the
      // point is to look at what is about to go public before it does.
      Actions: `view, Review "${slug}", ${url}`,
    },
    body: `Chat wants to publish "${slug}" at a public URL. Expires in 15 minutes.`,
    signal: AbortSignal.timeout(config.limits.httpTimeoutMs),
  }).catch((error: unknown) => {
    throw new Error(
      `Refused: could not reach the approval channel (${error instanceof Error ? error.message : String(error)}), so nothing was published.`,
    );
  });

  if (!res.ok) {
    pending.delete(token);
    throw new Error(
      `Refused: the approval channel returned HTTP ${res.status}, so nothing was published.`,
    );
  }
}

/** Looks a request up without spending it, for the review page. */
export function peek(token: string): Pending | null {
  sweep();
  return pending.get(token) ?? null;
}

/** Spends a request. Single use: a second press does nothing. */
export function consume(token: string): Pending | null {
  sweep();
  const entry = pending.get(token);
  if (!entry) return null;
  pending.delete(token);
  return entry;
}
