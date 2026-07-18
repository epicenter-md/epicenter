import { ROW_SYNC_ADMISSION_LIMITS } from "@epicenter/row-sync";
import { BEARER_SUBPROTOCOL_PREFIX, parseSubprotocols } from "@epicenter/sync";
import { DOCUMENT_SUBPROTOCOL } from "@epicenter/sync/document-v3";
import { Hono, type MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { extractUpgradeBearer } from "../auth/extract-upgrade-bearer.js";
import { OAuthError } from "../auth/oauth-errors.js";
import { createOAuthUnauthorizedResourceResponse } from "../auth/oauth-resource.js";
import type { WorkspaceDocuments } from "../document-hub/contracts.js";
import { isWebSocketUpgrade } from "../is-websocket-upgrade.js";
import type { Env, ResolveDocumentPrincipal } from "../types.js";

const WORKSPACES_PREFIX = "/api/workspaces";
const DOCUMENT_ROUTE =
  `${WORKSPACES_PREFIX}/:workspaceId/tables/:table/rows/:rowId/document` as const;
const textEncoder = new TextEncoder();

function isBoundedIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    textEncoder.encode(value).byteLength <=
      ROW_SYNC_ADMISSION_LIMITS.identifierBytes
  );
}

function requireDocumentBearer<E extends Env>(
  resolveDocumentPrincipal: ResolveDocumentPrincipal<E>,
  resolveDocuments: (env: E["Bindings"]) => WorkspaceDocuments,
): MiddlewareHandler<E> {
  return createMiddleware<E>(async (c, next) => {
    const bearer = extractUpgradeBearer(c.req.raw.headers);
    const resolution = bearer
      ? await resolveDocumentPrincipal(c, bearer)
      : OAuthError.InvalidToken();
    const { data: authorization, error } = resolution;
    if (error) {
      const offered = parseSubprotocols(
        c.req.header("sec-websocket-protocol") ?? null,
      );
      if (isWebSocketUpgrade(c) && offered.includes(DOCUMENT_SUBPROTOCOL)) {
        return resolveDocuments(c.env).rejectUpgrade({
          request: c.req.raw,
          code: 4000 + error.status,
          reason: JSON.stringify(error),
        });
      }
      return createOAuthUnauthorizedResourceResponse(c, error);
    }
    c.set("principal", authorization.principal);
    c.set(
      "documentAuthorizationExpiresAt",
      authorization.authorizationExpiresAt,
    );
    await next();
  });
}

function createWorkspaceDocumentsApp<E extends Env>({
  resolveDocuments,
}: {
  resolveDocuments: (env: E["Bindings"]) => WorkspaceDocuments;
}): Hono<E> {
  return new Hono<E>().get(DOCUMENT_ROUTE, async (c) => {
    if (!isWebSocketUpgrade(c)) {
      return new Response("Row documents are WebSocket-only", { status: 426 });
    }

    const workspaceId = c.req.param("workspaceId");
    const table = c.req.param("table");
    const rowId = c.req.param("rowId");
    if (
      !isBoundedIdentifier(workspaceId) ||
      !isBoundedIdentifier(table) ||
      !isBoundedIdentifier(rowId)
    ) {
      return new Response(null, { status: 400 });
    }

    const offered = parseSubprotocols(
      c.req.header("sec-websocket-protocol") ?? null,
    );
    const bearerOffers = offered.filter((protocol) =>
      protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX),
    );
    const hasAuthorization = c.req.header("authorization") !== undefined;
    if (
      !offered.includes(DOCUMENT_SUBPROTOCOL) ||
      (hasAuthorization ? bearerOffers.length !== 0 : bearerOffers.length !== 1)
    ) {
      return new Response(null, { status: 400 });
    }

    // The account authority derives from the authenticated principal alone
    // (ADR-0092); the workspace id is a name inside that partition, so no
    // authorization lookup exists between authentication and the upgrade.
    return resolveDocuments(c.env).handleUpgrade({
      partition: { principalId: c.var.principal.id, workspaceId },
      address: { table, rowId },
      authorizationExpiresAt: c.var.documentAuthorizationExpiresAt,
      request: c.req.raw,
    });
  });
}

/** Mount one bearer-authenticated socket per open row document. */
export function mountWorkspaceDocumentsApp<E extends Env = Env>(
  app: Hono<E>,
  {
    resolveDocumentPrincipal,
    resolveDocuments,
  }: {
    resolveDocumentPrincipal: ResolveDocumentPrincipal<E>;
    resolveDocuments: (env: E["Bindings"]) => WorkspaceDocuments;
  },
): void {
  app.use(
    DOCUMENT_ROUTE,
    requireDocumentBearer(resolveDocumentPrincipal, resolveDocuments),
  );
  app.route("/", createWorkspaceDocumentsApp({ resolveDocuments }));
}
