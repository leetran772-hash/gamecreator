// Extra API routes (audio, imports, versioning), registered on the studio.
import type { IncomingMessage } from "node:http";
import type { Studio } from "./server";

export interface RouteContext {
  studio: Studio;
  name: string;
  dir: string;
  req: IncomingMessage;
  url: URL;
  sub?: string;
  readJson: () => Promise<Record<string, unknown>>;
  readBody: () => Promise<Buffer>;
}

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Third path segment: /api/p/<project>/<path>/<sub> */
  path: string;
  sub?: string;
  handler: (ctx: RouteContext) => Promise<unknown> | unknown;
}

export function registerExtraRoutes(_studio: Studio) {}
