# Yampi MCP

Servidor MCP que permite a um lojista Yampi conversar com sua própria loja a partir do
cliente Claude dele. Cada lojista hospeda a própria cópia: o projeto é distribuído como
código, nunca como serviço.

## Language

### Participantes

**Lojista**:
Pessoa que possui uma Loja Yampi e hospeda a própria Instância deste servidor.
_Avoid_: usuário, cliente, merchant

**Loja**:
Uma conta de e-commerce na Yampi, identificada por seu alias.
_Avoid_: conta, store, shop, tenant

**Instância**:
Um deploy deste servidor, pertencente a exatamente um Lojista e atendendo todas as Lojas
que a Credencial de Loja dele alcança.
_Avoid_: servidor, serviço, tenant, ambiente

**Conector**:
A entrada que o Lojista cadastra no cliente Claude dele apontando para sua Instância.
_Avoid_: integração, plugin, extensão

### Credenciais

**Credencial de Loja**:
O par User-Token e User-Secret-Key que concede acesso irrestrito a uma Loja. Apresentá-la
é o que prova ser o Lojista; não existe senha separada.
_Avoid_: token, chave de API, api key

**Concessão**:
A autorização que o Lojista dá a um Conector, guardando sua Credencial de Loja de forma
cifrada. Revogá-la desliga aquele Conector sem afetar os demais.
_Avoid_: sessão, login, grant, permissão

### Níveis de operação

**Leitura**:
Operação que apenas consulta a Loja. Sempre disponível.
_Avoid_: consulta, query, read-only

**Escrita Reversível**:
Operação que altera a Loja e cujo efeito o Lojista consegue desfazer pelo painel Yampi —
criar e editar produto, SKU, estoque, cupom.
_Avoid_: mutação, escrita segura

**Ação Vedada**:
Operação deliberadamente ausente do servidor por ser irreversível — cancelar pedido,
estornar compra, trocar gateway de pagamento. Não existe em código; não é uma
funcionalidade desligada.
_Avoid_: ação bloqueada, ação desabilitada, feature flag
