/**
 * pages-mcp — shared HTML pages the chat can create and edit, versioned in git
 * and served over the web.
 *
 * Two surfaces on one port:
 *   POST /mcp          the tools, bearer-authenticated, for Open WebUI
 *   GET  /<slug>       the rendered page, public, for anyone you share the link with
 *
 * The public half is deliberately read-only and unauthenticated: a page nobody
 * else can open is not a shared page. Nothing under /mcp is reachable without the
 * bearer, and no tool returns anything but the pages themselves.
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

import { config, vaultFetch } from "./config.js";
import {
  initRepo,
  isValidSlug,
  listPages,
  readPage,
  writePage,
  pageHistory,
  readRevision,
  revertPage,
  deletePage,
} from "./store.js";

const text = (value: unknown, isError = false) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
  ...(isError ? { isError: true } : {}),
});

/**
 * Handlers must not throw: a thrown error reaches the model as a protocol
 * failure. Refusals are ordinary results — Open WebUI raises on isError and the
 * model then reads a Python repr rather than the sentence.
 */
const guard =
  <A>(name: string, fn: (args: A) => Promise<ReturnType<typeof text>>) =>
  async (args: A) => {
    console.log(`[tool] ${name} ${JSON.stringify(args ?? {}).slice(0, 200)}`);
    try {
      return await fn(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Refused:")) return text(message);
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return text(
          `Refused: no page with that slug. Use list_pages to see what exists.`,
        );
      }
      return text(`Failed: ${message}`, true);
    }
  };

const slugSchema = z
  .string()
  .describe("Lowercase letters, digits and hyphens — this becomes the URL");

function createServer(): McpServer {
  const server = new McpServer({ name: "pages", version: "0.1.0" });

  server.registerTool(
    "list_pages",
    {
      description:
        "List every shared page with its public URL, size, when it last changed and the last change note.",
      inputSchema: z.object({
        filter: z
          .string()
          .optional()
          .describe("Only pages whose slug contains this"),
      }),
    },
    guard("list_pages", async ({ filter }) => {
      const pages = await listPages();
      return text(
        filter ? pages.filter((p) => p.slug.includes(filter)) : pages,
      );
    }),
  );

  server.registerTool(
    "read_page",
    {
      description:
        "Read a page's current HTML. Read before editing so you preserve what is already there rather than replacing it wholesale.",
      inputSchema: z.object({ slug: slugSchema }),
    },
    guard("read_page", async ({ slug }) => text(await readPage(slug))),
  );

  server.registerTool(
    "write_page",
    {
      description:
        "Create a page or replace its contents, recording a new revision. Pass complete HTML — a full document, styled inline. To change part of a page, read it first and send back the whole edited document.",
      inputSchema: z.object({
        slug: slugSchema,
        html: z.string().describe("The complete HTML document"),
        message: z
          .string()
          .describe("What changed and why — this becomes the revision note"),
      }),
    },
    guard("write_page", async ({ slug, html, message }) => {
      if (!isValidSlug(slug)) {
        return text(
          `Refused: "${slug}" is not a valid slug. Use lowercase letters, digits and hyphens, 2-64 characters, starting and ending alphanumeric.`,
        );
      }
      if (Buffer.byteLength(html, "utf8") > config.limits.maxPageBytes) {
        return text(
          `Refused: that page is larger than the ${config.limits.maxPageBytes / 1024} KB limit. A page is a document, not a bundle — link to assets rather than inlining them.`,
        );
      }
      return text(await writePage(slug, html, message));
    }),
  );

  server.registerTool(
    "page_history",
    {
      description:
        "Every revision of a page, newest first, with its commit id and note. Use the commit id with read_revision or restore_page.",
      inputSchema: z.object({
        slug: slugSchema,
        depth: z
          .number()
          .int()
          .min(1)
          .max(config.limits.maxHistoryDepth)
          .default(20),
      }),
    },
    guard("page_history", async ({ slug, depth }) =>
      text(await pageHistory(slug, depth)),
    ),
  );

  server.registerTool(
    "read_revision",
    {
      description:
        "Read a page as it was at a specific revision, without changing anything.",
      inputSchema: z.object({
        slug: slugSchema,
        commit: z.string().describe("Commit id from page_history"),
      }),
    },
    guard("read_revision", async ({ slug, commit }) =>
      text(await readRevision(slug, commit)),
    ),
  );

  server.registerTool(
    "restore_page",
    {
      description:
        "Restore a page to an earlier revision. Recorded as a new revision rather than rewriting history, so the restore is itself undoable.",
      inputSchema: z.object({
        slug: slugSchema,
        commit: z.string().describe("Commit id from page_history"),
      }),
    },
    guard("restore_page", async ({ slug, commit }) =>
      text(await revertPage(slug, commit)),
    ),
  );

  server.registerTool(
    "delete_page",
    {
      description:
        "Remove a page from the web. Its revisions remain in history, so restore_page can bring it back — this takes it down, it does not destroy it.",
      inputSchema: z.object({
        slug: slugSchema,
        message: z.string().describe("Why it is being taken down"),
      }),
    },
    guard("delete_page", async ({ slug, message }) =>
      text({ deleted: slug, commit: await deletePage(slug, message) }),
    ),
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ status: true });
});

let bearerToken = "";

app.post("/mcp", async (req, res) => {
  const provided = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!bearerToken || provided !== bearerToken) {
    console.warn(`[auth] rejected request from ${req.ip ?? "unknown"}`);
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createServer();
  res.on("close", () => {
    void transport.close?.();
    void server.close?.();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

/**
 * The public half. Serves one page per slug and nothing else — no directory
 * listing, no traversal, and the slug pattern is validated before it ever
 * becomes a path.
 */
app.get("/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!isValidSlug(slug)) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  try {
    const html = await readPage(slug);
    res
      .type("text/html; charset=utf-8")
      // The pages are model-authored; never let one be framed by another origin
      // or sniffed into a different content type.
      .set("X-Content-Type-Options", "nosniff")
      .set("X-Frame-Options", "SAMEORIGIN")
      .set("Referrer-Policy", "no-referrer")
      .send(html);
  } catch {
    res.status(404).type("text/plain").send("Not found");
  }
});

app.get("/", async (_req, res) => {
  const pages = await listPages();
  res
    .type("text/html; charset=utf-8")
    .send(
      `<!doctype html><meta charset="utf-8"><title>Pages</title>` +
        `<style>body{font:16px/1.6 system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem}` +
        `a{color:#0e7c86}li{margin:.4rem 0}</style><h1>Pages</h1><ul>` +
        pages
          .map(
            (p) =>
              `<li><a href="/${p.slug}">${p.slug}</a> <small>${new Date(p.updated).toISOString().slice(0, 10)}</small></li>`,
          )
          .join("") +
        `</ul>`,
    );
});

async function main() {
  await initRepo();
  bearerToken = await vaultFetch("PAGES_MCP_TOKEN");
  app.listen(config.port, "0.0.0.0", () => {
    console.log(`pages-mcp listening on :${config.port}`);
    console.log(`serving ${config.publicBase}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
