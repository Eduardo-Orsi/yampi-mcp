/**
 * yampi-mcp — servidor MCP remoto para lojas Yampi.
 *
 * Fiação: o OAuthProvider protege /mcp e cuida de DCR, PKCE e metadata; o
 * defaultHandler serve a tela onde o Lojista apresenta a Credencial de Loja.
 * As tools recebem um YampiClient já montado com a credencial da Concessão.
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { tratarAutorizacao, type Env, type PropsDaConcessao } from "./authorize";
import { registrarEscrita } from "./tools/escrita";
import { registrarLeitura } from "./tools/leitura";
import { registrarOfertas } from "./tools/ofertas";
import { YampiClient } from "./yampi";

export function criarServidor(props: PropsDaConcessao): McpServer {
  const server = new McpServer({ name: "yampi-mcp", version: "0.1.0" });
  const ctx = {
    client: new YampiClient({ userToken: props.userToken, secretKey: props.secretKey }),
    lojas: props.lojas,
  };
  registrarLeitura(server, ctx);
  registrarEscrita(server, ctx);
  registrarOfertas(server, ctx);
  return server;
}

const manipuladorMcp = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // O OAuthProvider injeta as props da Concessão no ExecutionContext.
    const props = (ctx as ExecutionContext & { props?: PropsDaConcessao }).props;
    if (!props?.userToken) {
      return new Response("Concessão sem credencial. Reconecte o conector.", { status: 401 });
    }
    return createMcpHandler(() => criarServidor(props))(request, env, ctx);
  },
};

const manipuladorPadrao = {
  fetch: (request: Request, env: Env) => tratarAutorizacao(request, env),
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: manipuladorMcp,
  defaultHandler: manipuladorPadrao,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["yampi"],
});
