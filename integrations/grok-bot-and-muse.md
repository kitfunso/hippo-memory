# Hippo + Grok Bot and the Muse app

Grok Bot and the Muse app run in the cloud. They reach hippo over HTTPS at `/mcp`, with an API key. You run `hippo serve` on your machine, mint a key and open a tunnel. Then you give the app the tunnel URL and the key.

Muse Code, Grok Build, Junie and Antigravity run on your machine. They need no tunnel; see [Agents on your machine](#agents-on-your-machine).

## 1. Start the server

Run steps 1 and 2 in the project folder where `hippo init` made `.hippo`. `hippo serve` and `hippo auth create` both use that folder's store. In a folder with no store, each stops and says to run `hippo init` first.

bash or zsh:

```bash
HIPPO_CLIENT_IP_HEADER=cf-connecting-ip HIPPO_TRUSTED_PROXIES=127.0.0.1,::1 hippo serve
```

PowerShell:

```powershell
$env:HIPPO_CLIENT_IP_HEADER = 'cf-connecting-ip'
$env:HIPPO_TRUSTED_PROXIES = '127.0.0.1,::1'
hippo serve
```

The server listens on `http://127.0.0.1:6789`. Cloudflare puts each caller's address in the `cf-connecting-ip` header. The two variables make hippo read that header from the tunnel on this machine, so each tunnel caller gets its own rate-limit bucket.

## 2. Mint a key

In a second terminal, in the same folder:

```bash
hippo auth create --label grok-bot
```

The command prints `key_id` and `plaintext`. Hippo shows the plaintext once, so copy it now. The key has the member role. Add `--ttl-days <n>` to set how many days it lasts.

Keep the key secret. Enter it only in the app's header field or in Muse's credential prompt, and never in a chat.

## 3. Open an HTTPS tunnel

Install `cloudflared` from [Cloudflare's downloads page](https://developers.cloudflare.com/tunnel/downloads/). Then start a quick tunnel. It needs no Cloudflare account:

```bash
cloudflared tunnel --url http://127.0.0.1:6789
```

`cloudflared` prints a `https://<name>.trycloudflare.com` URL. The app's server URL is that host plus `/mcp`:

```text
https://<name>.trycloudflare.com/mcp
```

[Cloudflare's quick tunnel guide](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) has the details. The URL works until you stop `cloudflared`.

For a URL that stays the same, create a named tunnel in your Cloudflare account. Publish an application and point its route at `http://127.0.0.1:6789`. Use `https://<your hostname>/mcp` as the server URL. [Cloudflare's named tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) lists each step.

## 4. Add hippo to Grok Bot

In the Grok Bot desktop app:

1. Open **Connect apps** from the sidebar.
2. Choose **Add a custom connector** at the bottom.
3. Enter a **Name**, for example `hippo`.
4. Set **Type** to **Remote HTTPS**.
5. Set **Server URL** to `https://<tunnel host>/mcp`.
6. Under **HTTP headers**, add `Authorization: Bearer <key>`.
7. Choose **Add plugin**.

Then ask the Bot to use hippo, for example: "Use hippo_recall to find what I decided about the release plan."

## 5. Add hippo to the Muse app

The Muse app has no MCP settings page. You ask Muse to build a Custom Connector, and Muse saves it as a skill. Send Muse this prompt with your URL in it:

```text
Build a custom integration to my hippo memory server. It is a remote MCP server over HTTP at https://<tunnel host>/mcp. It needs an Authorization: Bearer header with an API key. Connect to it, test every tool end to end, show me the results, and save the integration as a reusable skill. Ask me for the key through the secure credential flow.
```

If Muse asks about the transport, answer "HTTP at that URL". If it asks about auth, answer "a bearer token".

When Muse asks for credentials, type the key in its secure credential prompt. Muse keeps it in its Secure Credentials Store.

Muse tests each tool and saves the skill. Start a new conversation and ask Muse to use hippo.

## Agents on your machine

Muse Code, Grok Build, Junie and Antigravity read a local MCP config file. They need no tunnel and no key. `hippo init` writes the `hippo` entry when the host's folder exists. To write it for one host:

```bash
hippo hook install muse-code
hippo hook install grok-build
hippo hook install junie
hippo hook install antigravity
```

`hippo hook uninstall <name>` removes the entry. The README section [What hippo init changes](../README.md#what-hippo-init-changes) lists the file each host gets.

## Stop and revoke

When you finish:

1. Stop `cloudflared` with Ctrl+C. The quick tunnel URL stops working.
2. Stop `hippo serve` with Ctrl+C.
3. List the keys: `hippo auth list`.
4. Revoke the one you made: `hippo auth revoke <key_id>`.

A revoked key fails on its next request. To use hippo again, mint a new key and update the app.
