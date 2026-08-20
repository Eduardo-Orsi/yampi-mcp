/**
 * Tela de autorização. Aqui o Lojista apresenta a Credencial de Loja — o par
 * User-Token e User-Secret-Key do painel da Yampi. Apresentá-la É a autenticação:
 * quem a possui é o dono da loja, e não há senha separada para inventar, guardar
 * ou vazar.
 *
 * A credencial validada vai cifrada nas props da Concessão. O Claude nunca a vê;
 * recebe apenas um token opaco.
 */
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { YampiClient, YampiError, type Loja } from "./yampi";

export interface Env {
  OAUTH_PROVIDER: OAuthHelpers;
  OAUTH_KV: KVNamespace;
  /** Opcional: restringe a Instância a estes aliases, separados por vírgula. */
  LOJAS_PERMITIDAS?: string;
}

/**
 * Identificador da Concessão. Não pode conter `:` — a lib monta o código de
 * autorização como `userId:grantId:segredo` e o recorta em exatamente três
 * partes. Um dois-pontos aqui quebra toda a troca de token, e o erro só aparece
 * lá na frente como "Invalid authorization code format".
 */
export function idDaConcessao(lojas: Loja[]): string {
  return `yampi-${lojas.map((l) => l.id).join("-")}`;
}

export interface PropsDaConcessao {
  userToken: string;
  secretKey: string;
  lojas: Loja[];
}

/** Um `/authorize` público valida credenciais, então é um oráculo para testar chaves roubadas. */
const TENTATIVAS_POR_MINUTO = 5;

export async function tratarAutorizacao(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/authorize") return paginaInicial(url);

  if (request.method === "GET") {
    const pedido = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const cliente = await env.OAUTH_PROVIDER.lookupClient(pedido.clientId);
    return htmlFormulario(url.search, cliente?.clientName ?? pedido.clientId, null);
  }

  if (request.method !== "POST") return new Response("Método não permitido", { status: 405 });

  const form = await request.formData();
  const parametros = String(form.get("oauth_req") ?? "");
  const userToken = String(form.get("user_token") ?? "").trim();
  const secretKey = String(form.get("secret_key") ?? "").trim();

  // Revalida o pedido OAuth a partir dos parâmetros originais em vez de confiar
  // num blob de JSON vindo do formulário: cliente, redirect_uri e PKCE passam
  // de novo pela lib.
  const pedido: AuthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(
    new Request(url.origin + "/authorize" + parametros),
  );
  const cliente = await env.OAUTH_PROVIDER.lookupClient(pedido.clientId);
  const nomeCliente = cliente?.clientName ?? pedido.clientId;

  const excedeu = await excedeuTentativas(request, env);
  if (excedeu) {
    return htmlFormulario(parametros, nomeCliente, "Muitas tentativas. Aguarde um minuto.", 429);
  }

  if (!userToken || !secretKey) {
    return htmlFormulario(parametros, nomeCliente, "Preencha as duas credenciais.", 400);
  }

  let lojas: Loja[];
  try {
    lojas = await new YampiClient({ userToken, secretKey }).lojas();
  } catch (e) {
    // Nunca engula a causa: "credencial inválida" e "a chamada falhou" são
    // problemas diferentes, e chamar os dois de recusa manda o Lojista conferir
    // uma credencial que talvez esteja certa.
    const causa = e instanceof YampiError ? e.message : e instanceof Error ? e.message : String(e);
    console.error("falha ao validar credencial:", causa);
    const recusa = e instanceof YampiError && (e.status === 401 || e.status === 403);
    return htmlFormulario(
      parametros,
      nomeCliente,
      recusa
        ? "A Yampi recusou essas credenciais. Confira em Perfil › Credenciais de API no painel."
        : `Não foi possível validar com a Yampi: ${causa}`,
      recusa ? 401 : 502,
    );
  }

  const permitidas = env.LOJAS_PERMITIDAS?.split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (permitidas?.length) lojas = lojas.filter((l) => permitidas.includes(l.alias));

  if (lojas.length === 0) {
    return htmlFormulario(parametros, nomeCliente, "Credencial válida, mas sem loja acessível nesta Instância.", 403);
  }

  const props: PropsDaConcessao = { userToken, secretKey, lojas };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pedido,
    userId: idDaConcessao(lojas),
    metadata: { clientName: nomeCliente, lojas: lojas.map((l) => l.alias) },
    scope: pedido.scope,
    props,
  });
  return Response.redirect(redirectTo, 302);
}

async function excedeuTentativas(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "desconhecido";
  const janela = Math.floor(Date.now() / 60_000);
  const chave = `tentativa:${ip}:${janela}`;
  const atual = Number((await env.OAUTH_KV.get(chave)) ?? 0);
  if (atual >= TENTATIVAS_POR_MINUTO) return true;
  await env.OAUTH_KV.put(chave, String(atual + 1), { expirationTtl: 120 });
  return false;
}

function escapar(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function paginaInicial(url: URL): Response {
  return new Response(
    `yampi-mcp\n\nServidor MCP para lojas Yampi.\nAdicione ${url.origin}/mcp como conector no seu cliente Claude.\n`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

function htmlFormulario(
  parametros: string,
  nomeCliente: string,
  erro: string | null,
  status = 200,
): Response {
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar loja Yampi</title>
<style>
 :root{color-scheme:light dark}
 body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:6vh auto;padding:0 1.25rem}
 h1{font-size:1.3rem;margin:0 0 .25rem}
 p{color:#666;margin:.25rem 0 1.5rem}
 label{display:block;margin:1rem 0 .3rem;font-weight:600;font-size:.9rem}
 input{width:100%;padding:.6rem;font:inherit;border:1px solid #8888;border-radius:.4rem;background:transparent;color:inherit}
 button{margin-top:1.5rem;width:100%;padding:.7rem;font:inherit;font-weight:600;border:0;border-radius:.4rem;background:#2d6cdf;color:#fff;cursor:pointer}
 .erro{background:#d3202033;border-left:3px solid #d32020;padding:.7rem;border-radius:.3rem;margin-bottom:1rem}
 .ajuda{margin-top:2rem;font-size:.85rem;color:#888}
 code{background:#8881;padding:.1rem .3rem;border-radius:.2rem}
</style></head><body>
<h1>Conectar loja Yampi</h1>
<p><strong>${escapar(nomeCliente)}</strong> quer acessar suas lojas Yampi.</p>
${erro ? `<div class="erro">${escapar(erro)}</div>` : ""}
<form method="POST" action="/authorize">
 <input type="hidden" name="oauth_req" value="${escapar(parametros)}">
 <label for="ut">User-Token</label>
 <input id="ut" name="user_token" required autocomplete="off" spellcheck="false">
 <label for="sk">User-Secret-Key</label>
 <input id="sk" name="secret_key" type="password" required autocomplete="off">
 <button type="submit">Autorizar</button>
</form>
<p class="ajuda">No painel da Yampi: <code>Perfil › Credenciais de API</code>.
Suas credenciais ficam cifradas nesta Instância e nunca são enviadas ao Claude.
Todas as lojas ligadas a essa credencial ficam disponíveis.</p>
</body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
