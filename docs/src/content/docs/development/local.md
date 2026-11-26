---
title: ローカルで開発する
description: 手元でLibrenoを動かす手順と、開発で使うコマンド。
---

ログイン、ユーザー管理、MCPのOAuth認可サーバーは[`@i2bskn/workers-app-core`](https://docs.i2bskn.com/workers-app-core/)を使っています（`src/core.ts`）。

Node.jsとpnpmが必要です。

```sh
pnpm install
cp .dev.vars.example .dev.vars   # JWT_SECRET を設定する
pnpm db:migrate:local
pnpm dev
```

`pnpm dev`はWeb画面（`client/`）をビルドしてから`wrangler dev`を起動します。`client/`のファイルを変えると自動で再ビルドされます。HMRは無いので、ブラウザを再読み込みしてください。

:::note
CookieにSecure属性と`__Host-`接頭辞を使っているので、`http://localhost`ではSafariでログインできません。ChromeかFirefoxを使ってください。
:::

## コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm test` | テスト |
| `pnpm typecheck` | 型チェック（サーバーとWeb画面） |
| `pnpm build:client` | Web画面を`dist/client`にビルドする |
| `pnpm db:generate` | スキーマからマイグレーションを作る |
| `pnpm run deploy` | 本番のD1にマイグレーションを適用してデプロイする（`pnpm deploy`はpnpm自体のコマンドなので`run`を付けてください）。Cloudflareのアカウントが複数あるときは`CLOUDFLARE_ACCOUNT_ID`にデプロイ先のアカウントIDを指定してください |
