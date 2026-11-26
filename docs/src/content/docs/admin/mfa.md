---
title: 多要素認証
description: パスワード認証でパスキーと認証アプリを使う設定と、失くしたときの対処。
---

パスワード認証では、パスワードに加えてパスキー（WebAuthn）や認証アプリ（TOTP）を使えます。ログイン画面の「多要素認証の設定」（`/auth/mfa/manage`）から登録します。登録すると、失くしたときのためのリカバリーコードが表示されます。認証方法とは別の場所に保管してください。

## 必要な設定

| 認証方法 | 必要な設定 |
| --- | --- |
| パスキー | `APP_ORIGIN`。`APP_ORIGIN`のOriginで開いたときだけ使えます。`*.workers.dev`のURLや別のホスト名で開いたときは使えません |
| 認証アプリ | `PASSWORD_MFA_KEY`。変えると登録済みの認証アプリが使えなくなります（使っていないリカバリーコードで登録し直せます） |

## 登録を求める範囲

`PASSWORD_MFA_POLICY`で決めます。

| 値 | 登録を求められる人 |
| --- | --- |
| `optional`（既定） | なし。登録するかどうかは各自が決めます |
| `admins` | 管理者 |
| `all` | 全員。初期設定画面で作る最初の管理者にも効きます |

登録した人は、どの設定でもログインのたびに多要素認証を使います。

## 失くしたとき

認証方法とリカバリーコードをすべて失くした人は、ほかの管理者が「ユーザー管理」の「多要素認証をリセット」で登録を消せます（[ユーザーを管理する](/libreno/admin/users/)）。

管理者が1人だけで、その管理者が認証方法とリカバリーコードをすべて失くしたときは、D1の行を直接削除します。メールアドレスは小文字で保存されています。

```sh
wrangler d1 execute <DATABASE> --remote --command "
DELETE FROM mfa_pending WHERE user_id = (SELECT id FROM users WHERE email = 'admin@example.com');
DELETE FROM mfa_recovery_codes WHERE user_id = (SELECT id FROM users WHERE email = 'admin@example.com');
DELETE FROM mfa_credentials WHERE user_id = (SELECT id FROM users WHERE email = 'admin@example.com');
DELETE FROM mfa_accounts WHERE user_id = (SELECT id FROM users WHERE email = 'admin@example.com');
"
```

この操作ではセッションとMCPの接続は切れません。
