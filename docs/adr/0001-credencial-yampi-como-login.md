# A Credencial de Loja é o login, sem senha separada

A tela de `/authorize` pede o `User-Token` e o `User-Secret-Key` do painel da Yampi e valida
os dois chamando `POST /v2/auth/me`. Não há senha, IdP nem Cloudflare Access na frente:
quem consegue apresentar uma Credencial de Loja válida **é** o Lojista, então exigir um
segundo segredo só criaria mais uma coisa para guardar, rotacionar e vazar.

## Considered Options

- **URL authless com segredo no caminho.** Suportada pelo Claude e a mais simples de todas,
  mas transforma o link num portador de acesso total: vazou a URL, vazou a loja. Descartada
  porque o projeto é público e o link circula em prints e arquivos de configuração.
- **Cloudflare Access na frente do `/mcp`.** Não funciona: quem busca a URL do conector é o
  servidor da Anthropic, sem navegador, então não há sessão para o Access autenticar. Ele
  responderia 403. (Funcionaria no `/authorize`, que é aberto no navegador — mas aí seria um
  terceiro segredo resolvendo um problema que a Credencial de Loja já resolve.)
- **OAuth 2.0 da própria Yampi.** É a experiência ideal, de um clique, mas a Yampi restringe
  OAuth a aplicativos publicados na Loja de Aplicativos deles, o que exige aprovação prévia
  e vira parceria. Fora do escopo deste projeto.

## Consequences

O `/authorize` é público e valida credenciais, o que o torna um oráculo para testar chaves
roubadas. Daí o limite de 5 tentativas por IP por minuto em `authorize.ts`.

Em compensação, o deploy não precisa de nenhuma configuração de segredo: sobe o Worker e
conecta. E a Credencial nunca chega ao Claude — ela vai cifrada nas props da Concessão, com
a chave de cifra envelopada por uma chave derivada do token. Como o KV guarda apenas o hash
do token, um vazamento do KV sozinho não abre as credenciais.
