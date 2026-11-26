# Libreno

**チームの情報を、AIと一緒に育てる場所。**

Librenoは小さなチームのための情報共有ツールです。チームで共有したいことは種類を問わず1か所にまとめておけます。

AIが書いて、チームが読む。これがLibrenoの基本の考え方です。

### 書くのはAIに任せる

ClaudeなどのアプリからMCPで接続して「経費申請の手順をまとめて」と頼めば、AIがページを書いて保存します。既存のページを読んで直すことも関係するページを探すこともAIに任せられます。本文はMarkdownなのでAIが書いたものをそのまま置けます。

### 読む人はブラウザで開くだけ

チームの人はWebでページを読んだり検索したりします。ページを開いたときは読むための表示なので、うっかり書き換えることはありません。直したいときは編集ボタンから編集できます。

### 見せる相手はスペースで分ける

スペースごとに見られる人を分けられます。種類は4つです。

- 全員が見られるスペース
- 管理者だけが見られるスペース（経理や人事など）
- 管理者が選んだメンバーと管理者が見られるスペース（プロジェクトのチームなど）
- 本人だけが見られるスペース（個人のメモ）

AIもWebと同じ権限で動くので、見られないページをAIが読むことはありません。

### 自分たちのCloudflareアカウントで動く

Cloudflare Workers・D1・R2の上で動きます。「Deploy to Cloudflare」ボタンで自分のアカウントにデプロイでき、データは自分のD1とR2に置かれます。

## デプロイする

**デプロイの前にCloudflareのダッシュボードでR2を有効にしてください（R2のサブスクリプションを追加します）。** 添付ファイルの保存にR2を使うので、有効にしていないとデプロイが失敗します。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/i2bskn/libreno)

セットアップ画面では`JWT_SECRET`を入力します。`openssl rand -hex 32`で生成した値を使ってください。

デプロイ直後はパスワード認証で動きます。表示されたURLを開くと初期設定画面になり、**最初に登録した人が管理者になります**。URLを知った他人に先に登録されないように、デプロイしたらすぐ登録してください。

## ドキュメント

使い方と設定は https://docs.i2bskn.com/libreno/ にまとめています。

- [デプロイする](https://docs.i2bskn.com/libreno/getting-started/deploy/)
- [動作環境](https://docs.i2bskn.com/libreno/getting-started/requirements/)（Workersの無料プランで動く範囲）
- [MCPで接続する](https://docs.i2bskn.com/libreno/getting-started/mcp/)
- [設定](https://docs.i2bskn.com/libreno/admin/configuration/)
- [更新とバックアップ](https://docs.i2bskn.com/libreno/admin/upgrading/)
- [ローカルで開発する](https://docs.i2bskn.com/libreno/development/local/)

ドキュメントのソースは[`docs/`](docs/)にあります。

## ライセンス

[Apache License 2.0](LICENSE)
