# Yampi MCP

MCP server that lets a Yampi merchant talk to their own store from their Claude client.
Each merchant hosts their own copy: the project is distributed as code, never as a service.

## Language

### Participants

**Merchant**:
A person who owns a Yampi Store and hosts their own Instance of this server.
_Avoid_: user, customer, client, lojista

**Store**:
An e-commerce account on Yampi, identified by its alias.
_Avoid_: account, shop, tenant, loja

**Instance**:
One deploy of this server, belonging to exactly one Merchant and serving every Store the
Merchant's Store Credential reaches.
_Avoid_: server, service, tenant, environment

**Connector**:
The entry the Merchant registers in their Claude client pointing at their Instance.
_Avoid_: integration, plugin, extension

### Credentials

**Store Credential**:
The User-Token / User-Secret-Key pair granting unrestricted access to a Store. Presenting it
is what proves you are the Merchant; there is no separate password.
_Avoid_: token, API key, api key

**Grant**:
The authorization the Merchant gives a Connector, holding their Store Credential encrypted.
Revoking it turns off that Connector without affecting the others.
_Avoid_: session, login, permission

### Operation levels

**Read**:
An operation that only queries the Store. Always available.
_Avoid_: query, lookup, read-only

**Reversible Write**:
An operation that changes the Store and whose effect the Merchant can undo from the Yampi
dashboard — creating and editing a product, SKU, stock, coupon.
_Avoid_: mutation, safe write

**Forbidden Action**:
An operation deliberately absent from the server because it is irreversible — cancelling an
order, refunding a purchase, switching payment gateway. It does not exist in code; it is not
a feature that was switched off.
_Avoid_: blocked action, disabled action, feature flag
