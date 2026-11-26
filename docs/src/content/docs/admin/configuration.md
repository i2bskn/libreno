---
title: 設定
description: Cloudflareのダッシュボードで設定する変数とシークレットの一覧。
---

設定はCloudflareのダッシュボードの「設定」→「変数とシークレット」で行います。`wrangler.jsonc`で`keep_vars: true`を指定しているので、ダッシュボードで設定した値は再デプロイしても消えません。変数は「テキスト」の型で設定してください。

## 変数とシークレット

| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `JWT_SECRET` | シークレット | 必須。32文字以上 |
| `AUTH_MODE` | 変数 | `password`（既定）または`oidc` |
| `APP_ORIGIN` | 変数 | ブラウザで開くOrigin（例: `https://wiki.example.com`）。`oidc`のとき必須。`password`ではパスキー（WebAuthn）を使う場合に必要 |
| `OIDC_ISSUER` | 変数 | `oidc`のとき必須。IdPのissuerそのもの。`/.well-known/`を含むURLは設定エラーになります |
| `OIDC_CLIENT_ID` | 変数 | `oidc`のとき必須 |
| `OIDC_CLIENT_SECRET` | シークレット | `oidc`のとき必須 |
| `INITIAL_ADMIN_EMAIL` | 変数 | `oidc`で使います。ユーザーがまだいないときに、このメールアドレスでログインした人が最初の管理者になります。ユーザーが1人でもいれば使われません |
| `OIDC_REQUIRE_EMAIL_VERIFIED` | 変数 | 任意。`false`にするとIDトークンに`email_verified`が含まれない場合に限ってログインを通します |
| `OIDC_REQUIRE_GOOGLE_HD` | 変数 | 任意。`oidc`で`true`にすると、初回ログイン（招待したユーザーとの紐付けと最初の管理者の作成）で、`@gmail.com`以外のアカウントにはIDトークンの空でない`hd`（Google Workspaceのドメイン）を必須にします。IdPがGoogle（またはGoogleだけを使うCloudflare Access）のときだけ使ってください。`true`と`false`以外の値では初回ログインを拒否します（500にはなりません） |
| `SESSION_MAX_AGE_HOURS` | 変数 | 任意。Webのログインが続く上限（ログインからの時間数）。`1`〜`9600`。未設定なら`password`で720（30日）、`oidc`で24 |
| `SESSION_IDLE_TIMEOUT_HOURS` | 変数 | 任意。Webを使わないままでいるとログアウトされるまでの時間数。`1`〜`9600`。使うたびに`SESSION_MAX_AGE_HOURS`の上限まで延びます。未設定なら使っていてもいなくても`SESSION_MAX_AGE_HOURS`で切れます |
| `PASSWORD_MFA_POLICY` | 変数 | 任意。`password`での多要素認証の要否。`optional`（既定。各自が任意で設定）・`admins`（管理者は必須）・`all`（全員必須） |
| `PASSWORD_MFA_KEY` | シークレット | 任意。`password`で認証アプリ（TOTP）を使う場合に設定します。`openssl rand -base64 32`で生成した値を使ってください。変えると登録済みの認証アプリが使えなくなります |
| `PASSWORD_HASH_ALGORITHM` | 変数 | 任意。新しく設定するパスワードのハッシュの方式。`scrypt`（既定）または`pbkdf2`。`AUTH_MODE`に関係なく、それ以外の値は設定エラーになります |
| `PASSWORD_PBKDF2_ITERATIONS` | 変数 | 任意。`pbkdf2`のときのハッシュの回数。`10000`〜`100000`。未設定なら`100000`。`AUTH_MODE`に関係なく検証され、`scrypt`のときも範囲外は設定エラーになります |
| `PDF_RENDERER` | 変数 | 任意。`browser`にするとページのPDFをサーバー（Browser Rendering）で作ります。未設定ならブラウザの印刷機能を使います |

## 設定の誤り

:::caution
設定に誤りがあると、すべてのリクエストが500になります。
:::

たとえば次の場合です。

- `PASSWORD_MFA_POLICY`が`optional`・`admins`・`all`のどれでもない。
- `PASSWORD_MFA_POLICY`が`admins`か`all`なのに、有効なHTTPSの`APP_ORIGIN`も`PASSWORD_MFA_KEY`もない（多要素認証を登録する方法がない）。
- `PASSWORD_MFA_KEY`が32バイトのbase64（`openssl rand -base64 32`の出力）ではない。
- `INITIAL_ADMIN_EMAIL`がメールアドレスとして正しくない。
- `PASSWORD_HASH_ALGORITHM`が`scrypt`・`pbkdf2`のどちらでもない。
- `PASSWORD_PBKDF2_ITERATIONS`が`10000`〜`100000`の整数ではない。
- `OIDC_ISSUER`が`/.well-known/`を含む。

`OIDC_REQUIRE_GOOGLE_HD`は例外で、誤った値では初回ログインだけを拒否します。

## ログインが続く時間

`SESSION_MAX_AGE_HOURS`を変えると、次にログインしたときから効きます。`SESSION_IDLE_TIMEOUT_HOURS`はログイン中の人にもすぐに効きます。

たとえば`SESSION_IDLE_TIMEOUT_HOURS`を`168`、`SESSION_MAX_AGE_HOURS`を`720`にすると、7日使わなければログアウトされ、使い続けていても30日でログインし直すことになります。

## パスワードのログインの回数制限

パスワード認証のログインは、同じメールアドレスにつき1分間に5回までです。超えるとパスワードを確かめずに429を返し、「ログインの試行が多すぎます」と表示します。回数と期間は`wrangler.jsonc`の`ratelimits`（`LOGIN_RATE_LIMITER`）で変えられます。期間は10秒か60秒のどちらかです。

- 回数はCloudflareの拠点ごとに数えるので、上限は目安です。
- メールアドレスを知っている人が上限を超えて試し続けると、その間は本人もパスワードでログインできません。
- 1つのパスワードを多くのメールアドレスで試す攻撃は止められません。
- 同じCloudflareアカウントのWorkerどうしで`namespace_id`が同じだと、回数を共有します。ほかのWorkerが`4201`を使っている場合は別の数に変えてください。
