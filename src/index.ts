/**
 * yampi-mcp — remote MCP server for Yampi stores.
 *
 * Wiring: the OAuthProvider protects /mcp and handles DCR, PKCE and metadata; the
 * defaultHandler serves the screen where the Merchant presents the Store Credential.
 * The tools receive a YampiClient already built with the Grant's credential.
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { handleAuthorize, type Env, type GrantProps } from "./authorize";
import { registerOfferTools } from "./tools/offers";
import { registerReadTools } from "./tools/read";
import { registerWriteTools } from "./tools/write";
import { YampiClient } from "./yampi";

/**
 * Branding advertised in `serverInfo`. No Claude client renders `icons` today
 * (modelcontextprotocol/inspector#152) — this is here for the day one does.
 * `src` is absolute because the client fetches it without a base URL.
 */
const BRANDING = {
  title: "Yampi",
  description: "Read and manage your Yampi stores: orders, products, customers, coupons, offers.",
  websiteUrl: "https://github.com/Eduardo-Orsi/yampi-mcp",
  icons: [
    {
      src: "https://raw.githubusercontent.com/Eduardo-Orsi/yampi-mcp/main/assets/yampi-icon.png",
      mimeType: "image/png",
      sizes: ["512x512"],
    },
  ],
};

export function createServer(props: GrantProps): McpServer {
  const server = new McpServer({ name: "yampi-mcp", version: "0.1.0", ...BRANDING });
  const ctx = {
    client: new YampiClient({ userToken: props.userToken, secretKey: props.secretKey }),
    stores: props.stores,
  };
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  registerOfferTools(server, ctx);
  return server;
}

const mcpHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // The OAuthProvider injects the Grant props into the ExecutionContext.
    const props = (ctx as ExecutionContext & { props?: GrantProps }).props;
    if (!props?.userToken) {
      return new Response("Grant without credential. Reconnect the connector.", { status: 401 });
    }
    return createMcpHandler(() => createServer(props))(request, env, ctx);
  },
};

const defaultHandler = {
  fetch: (request: Request, env: Env) => handleAuthorize(request, env),
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["yampi"],
});
