# Qianshou phone shell

English | [中文](README.zh.md)

`apps/qianshou-mobile` is a dedicated phone product UI. It is not a responsive copy of the desktop workbench and it is not a compute contributor. The shell presents conversation, agent catalog, discover, tasks, dispatch, account, and a left drawer at iPhone 390×844, using a designed SVG icon set and generated raster media under `public/media/`.

## Start

From the repository root:

```sh
pnpm install
pnpm --filter @qianshou/mobile dev
```

Open `http://127.0.0.1:4174/` in a phone-width viewport. The replica currently holds designed sample content; it does not log into a PC session, submit live tasks, or charge an account.

## Limits

Pairing, PC-window command delivery, and store payment remain in `@deepseek-ai/dsh-client-pc-window-bridge` and the host mobile gateway. This app owns presentation and local interaction only.
