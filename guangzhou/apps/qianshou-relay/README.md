# Dedicated collaboration relay

English | [中文](README.zh.md)

This operational service exposes one privately enrolled Qianshou controller's device WebSocket through FRP 0.71.0. It runs beside existing server workloads and does not run the Harness agent, store device credentials, or expose controller HTTP APIs. The controller and companion both establish outbound encrypted connections; the existing [device protocol](../../packages/host/remote-devices/README.md) continues to own pairing, revocation, local approval, task execution and receipts.

## Public and private listeners

| Listener | Purpose |
| --- | --- |
| HTTPS `24443`, exact `/qianshou-device` | Native companion WebSocket; controller requires the first bounded frame to authenticate or pair. |
| HTTPS `24443`, exact `/~!frp` | Controller WSS transport; FRP requires the independently issued registration token and enrolled controller identity. |
| HTTPS `24443`, exact `/healthz` | Public service metadata; this response alone does not establish a connected controller. |
| Loopback `17440` / `17441` / `17442` | FRP control transport, HTTP virtual host and registration-policy RPC. None binds a public address. |
| Existing HTTP `80`, ACME challenge prefix | Certificate authority validation files only; existing business routes and listeners remain byte-preserved. |

Nginx rejects other public paths and non-WebSocket device requests. The registration plugin accepts only the enrolled identity, its `devices` HTTP proxy, one domain and `/qianshou-device`; alternate protocols, wildcard paths, extra hosts and header overrides fail closed. This is a single-controller deployment. Sharing its registration secret between independent controllers is unsupported; separate owners require separately enrolled routing identities and isolated public mappings.

The relay terminates TLS and is therefore trusted to handle device messages. Encryption protects both Internet legs; it is not application-level end-to-end encryption against the relay administrator. Access logs are disabled and policy RPC request bodies are not logged. Registration secrets and ACME account keys stay in independently protected server files. A future direct screen session remains a separate [RustDesk](https://rustdesk.com/docs/en/self-host/rustdesk-server-oss/install/) connection; this service does not forward desktop pixels or install `hbbs`/`hbbr`.

## Deployment tutorial

Use an administrator-owned Ubuntu server with Nginx, Docker, Python 3, a reachable public IPv4 address and a dedicated reachable port 24443. Inspect active services, listeners and Nginx configuration first. The preparation script requires the observed SHA-256 of the existing business server and refuses an unexpected or already modified configuration. Existing FRP, database, media and API services are outside its ownership.

1. Place these Python modules and the official `frp_0.71.0_linux_amd64.tar.gz` in root-owned `/opt/qianshou-agent-relay`. Verify the archive against its upstream release SHA-256 before execution. The desktop [FRP lock](../qianshou-desktop/relay/frpc.lock.json) records the same release and public certificate roots.
2. Pull the digest-pinned Certbot image from [certificate.py](certificate.py). Run `python3 prepare_acme.py --site <business-nginx-file> --expected-sha256 <observed-sha256>`. It records a private backup, adds one ACME include, checks Nginx syntax and reloads. Verify the dedicated challenge probe from outside the server.
3. Run `python3 certificate.py --stage staging --ip <public-ip>` and then `--stage production` with the same IP. The staging authority proves challenge reachability without consuming production issuance limits; only the production certificate is used publicly.
4. Run `python3 install_relay.py --ip <public-ip> --archive <verified-frp-archive> --sha256 <official-sha256>`. The installer creates a service account, private enrollment, bounded policy service, independent FRP service, HTTPS server and certificate-renewal timer. An existing enrollment is never overwritten.
5. Transfer `/etc/qianshou-agent-relay/enrollment.json` to the owner's computer through an authenticated private channel, preserving account-only permissions. Import it in the controller's relay configuration and enable the connection. This file must never enter source control, downloadable archives, screenshots or device invitations. Companions receive only the public endpoint and a current controller-issued pairing code.
6. Run `python3 certificate.py --stage check --ip <public-ip>` for an ACME renewal dry run, then `python3 verify_server.py` for a non-secret deployment receipt. Confirm public TLS trust, negative authentication tests and one locally approved task before declaring the device link usable.

## Renewal and rollback

[Let's Encrypt IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability) require the `shortlived` profile and last 160 hours. The dedicated systemd timer checks renewal every 12 hours with randomized delay and persistent missed-run handling. The oneshot uses the pinned Certbot container, verifies Nginx configuration and reloads certificates on success. `systemctl status qianshou-relay-certificate.service` and its exit status report failures; no success is inferred from the timer being enabled. Certificate and account state reside under `/var/lib/qianshou-agent-relay/acme`; the [official Certbot IP instructions](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html) explain why webroot validation and explicit reload are required.

`python3 /opt/qianshou-agent-relay/rollback.py` stops only the relay and its renewal timer, removes the isolated HTTPS server and restores the byte-verified ACME edit. It refuses to overwrite later business configuration changes. Credentials and certificates remain for administrator review; the script neither deletes unrelated resources nor modifies an existing FRP service. Review pinned upstream security releases deliberately before changing the lock or Certbot digest.

## Verification

Run `python3 -m unittest discover -s apps/qianshou-relay/tests -v` for admission-policy checks. The [public transport test](../../packages/host/remote-devices/tests/relay-public.e2e.spec.ts) is explicitly enabled with `QIANSHOU_RELAY_ENROLLMENT`, `QIANSHOU_RELAY_FRPC` and `QIANSHOU_RELAY_CA`; `QIANSHOU_RELAY_RECEIPT` names an optional non-secret result file. Run it with `node node_modules/vitest/vitest.mjs run packages/host/remote-devices/tests/relay-public.e2e.spec.ts` only while its enrolled controller route is reserved for the test. It uses temporary coordinator/companion state, rejects invalid registrations and pairing attempts, verifies local approval and receipts, and closes every owned process. It calls no LLM and does not establish Windows or a separate physical recipient's acceptance. Deployment rationale belongs to the [decision note](../../.agents/notes/implemented/feature/2026-09-14-qianshou-dedicated-relay.md).
