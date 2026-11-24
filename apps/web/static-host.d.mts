import type { IncomingMessage, ServerResponse } from "node:http";

export declare function createStaticHost(options?: {
  root?: string;
  controlToken?: string;
  allowedStaticRoot?: string;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
