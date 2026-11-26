---
title: デプロイする
description: Deploy to Cloudflareボタンで自分のCloudflareアカウントにLibrenoをデプロイします。
---

:::caution[先にR2を有効にする]
デプロイの前にCloudflareのダッシュボードでR2を有効にしてください（R2のサブスクリプションを追加します）。添付ファイルの保存にR2を使うので、有効にしていないとデプロイが失敗します。
:::

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/i2bskn/libreno)

## ボタンを押すと行われること

1. このリポジトリがあなたのGitHubに新しいリポジトリとしてコピーされます（forkではありません）。
2. D1データベースとKVネームスペース（MCPの接続情報を保存）とR2バケット（添付ファイルを保存）が、あなたのCloudflareアカウントに1つずつ作られてWorkerに紐付きます。
3. Workers Buildsが設定されてマイグレーションの適用とデプロイが行われます。以降はコピーされたリポジトリへpushするたびにデプロイされます。

Web画面（React）は`wrangler.jsonc`の`build.command`で`wrangler deploy`の前に自動でビルドされます。Workers Buildsでビルドコマンドを設定する必要はありません。

## デプロイの流れ

デプロイには`pnpm run deploy`（[@i2bskn/workers-deploy](https://github.com/i2bskn/workers-deploy)の`workers-deploy`コマンド）が使われます。マイグレーションを適用してから`wrangler deploy`を実行し、新しいコードが動く前に表ができているようにします。

初回でD1がまだないときだけは、D1・KV・R2を自動で作る`wrangler deploy`を先に実行してからマイグレーションを適用します（`wrangler d1 migrations apply`は既存のD1を探すだけで、作らないため）。表ができるまでの数秒間はWorkerが表のない状態で動きますが、まだ誰も使っていないので影響はありません。

## JWT_SECRETを入力する

セットアップ画面では`JWT_SECRET`を入力します。次のコマンドで生成した値を使ってください。変更すると全員がログアウトします。

```sh
openssl rand -hex 32
```

## 最初の管理者を登録する

デプロイ直後はパスワード認証で動きます。表示されたURLを開くと初期設定画面になり、**最初に登録した人が管理者になります**。

:::danger
URLを知った他人に先に登録されないように、デプロイしたらすぐ登録してください。
:::

OIDC認証で使う場合は[OIDC認証にする](/libreno/admin/oidc/)を参照してください。

次へ: [動作環境](/libreno/getting-started/requirements/)で無料プランで動く範囲を確かめる。
