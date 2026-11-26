---
title: OIDC認証にする
description: IdPでログインする招待制のOIDC認証と、Cloudflare Accessを使う場合の設定。
---

OIDC認証は招待制です。ログインできるのは、管理者が「ユーザー管理」で追加した人だけです。

- ユーザーがまだいないときは、`INITIAL_ADMIN_EMAIL`のメールアドレスでログインした人が最初の管理者になります。`INITIAL_ADMIN_EMAIL`を設定しないと、誰もログインできません。
- 2人目からは、管理者が「ユーザー管理」でメールアドレスとロールを登録します。登録された人が初回ログインすると、メールアドレスが一致した登録ユーザーにIdPのアカウントが紐付きます。2回目からはIdPのアカウントで本人を判定し、メールアドレスは見ません。
- 登録されていないメールアドレスでログインすると403になり、ユーザーは作られません。

## IdPの設定

1. IdPにリダイレクトURLとして`<APP_ORIGIN>/auth/oidc/callback`を設定する。
2. スコープに`openid`と`email`と`profile`を設定する。
3. Librenoの変数`AUTH_MODE`を`oidc`にし、`APP_ORIGIN`・`OIDC_ISSUER`・`OIDC_CLIENT_ID`・`OIDC_CLIENT_SECRET`を設定する（[設定](/libreno/admin/configuration/)）。

## Cloudflare Accessを使う

Cloudflare Accessを使う場合は、Access for SaaSのOIDCアプリとして登録します（Accessをアプリの前に置く構成には対応していません）。

AccessのIDトークンには既定では`email_verified`が含まれないので、`OIDC_REQUIRE_EMAIL_VERIFIED`を`false`にしてください。

:::danger
この設定を使うのは、Accessのログイン方法がすべてメールを検証済みのIdP（Googleなど）である場合だけにしてください。招待したユーザーとはメールアドレスで紐付くので、メールを検証しないログイン方法があると他人のアカウントに入れてしまいます。
:::

AccessのOIDCアプリの設定にある「Add claims」で、Google IdPから取り込んだ`verified_email`を`email_verified`としてIDトークンに渡すと、`OIDC_REQUIRE_EMAIL_VERIFIED=false`を使わずに済む場合があります。値が真偽値の`true`で届くかはIdPとAccessの設定によります。設定を変えたら新しいユーザーのログインで確かめ、拒否されたら`OIDC_REQUIRE_EMAIL_VERIFIED=false`に戻してください。

Accessで`OIDC_REQUIRE_GOOGLE_HD`を使う場合は、同じ「Add claims」でGoogle IdPから取り込んだ`hd`を同じ名前で渡してください。Gmailのアカウントには`hd`がないので、このクレームはRequiredにしないでください。

## パスワード認証から切り替える

パスワード認証からOIDC認証に切り替えるときは、ユーザーがすでにいるので`INITIAL_ADMIN_EMAIL`は使われません。

切り替える前に、各ユーザーのメールアドレスがIdPのメールアドレスと一致しているか確かめてください。一致した人は初回のOIDCログインで紐付きます。特に管理者のメールアドレスが一致していないと、誰もユーザーを追加できなくなります。ユーザーのメールアドレスはあとから変えられないので、一致しない人はIdPのメールアドレスで追加し直してください。

## ALLOWED_EMAILSを使っていた版から更新する

以前のOIDC認証では、`ALLOWED_EMAILS`に合う人は初回ログインでユーザーが自動で作られました。更新後は「ユーザー管理」に登録済みの人しかログインできません。

- 更新する前に「ユーザー管理」の一覧と`ALLOWED_EMAILS`を見比べ、ログインさせたくないユーザーを削除してください。一覧にいるユーザーは`ALLOWED_EMAILS`と関係なくログインできるようになります。
- ドメインの指定や`*`で新しい人が自分でログインできていた運用では、管理者が「ユーザー管理」で追加するまで、新しい人は403になります。
- 更新後は`ALLOWED_EMAILS`は読まれないので、削除してかまいません。
