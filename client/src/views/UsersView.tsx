import { type FormEvent, useRef, useState } from "react";
import type { CreateUserRequest, User } from "../../../src/api/types";
import {
  type IssueInvitationResult,
  type UserActionResult,
  changeUserRole,
  createUser,
  deleteUser,
  issueInvitation,
  resetUserMfa,
  resetUserPassword,
  revokeUserSessions,
} from "../actions";
import { formatDateTime } from "../format";
import { PlusIcon } from "../icons";
import { type ApiClient, type UsersData, loadUsersView, useView } from "../load";
import { useSidebarLocation } from "../sidebarStore";
import { ViewStatus, useDocumentTitle, viewTitle } from "./common";

type Role = User["role"];
type AuthMode = UsersData["authMode"];
type Operation = "role" | "invite" | "password" | "mfa" | "logout" | "delete";
// An invitation link just issued, shown once above the list. label is the user it was issued for.
type IssuedInvitation = { label: string; url: string; expiresAt: number };

const ROLE_LABELS: Record<Role, string> = { admin: "管理者", member: "一般" };
const GONE_MESSAGE = "このユーザーは見つかりません。削除された可能性があります";
const UNKNOWN_RESULT_MESSAGE = "サーバーに接続できませんでした。読み込み直して確かめてください";

// The screen for admins to manage users. The server checks the role again; a member who opens the URL
// sees its 403 message. currentUserId is the signed-in user, who cannot delete or sign out themselves here.
export function UsersView({ client, currentUserId }: { client: ApiClient; currentUserId: string }) {
  const [state, reload] = useView(() => loadUsersView(client), "users");
  // The result of the last operation, shown above the list until the next one. It stays across the reload
  // that follows, which may remove the row the operation was opened from.
  const [notice, setNotice] = useState<string | null>(null);
  // The invitation link issued by the last operation. Like notice, it stays across the reload that follows and
  // goes away when another operation starts. The link cannot be shown again, so it is kept until then.
  const [invitation, setInvitation] = useState<IssuedInvitation | null>(null);
  useDocumentTitle(viewTitle(state, () => "ユーザー管理"));
  useSidebarLocation(null);

  if (state.kind !== "ready") {
    return <ViewStatus state={state} notFoundMessage="ページが見つかりません" onReload={reload} />;
  }
  const { users, authMode } = state.data;

  // An operation starting clears both the notice and the invitation link of the previous one.
  function showNotice(next: string | null) {
    setNotice(next);
    if (next === null) setInvitation(null);
  }

  return (
    <main className="main">
      <h1>ユーザー管理</h1>
      {notice !== null && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {invitation !== null && (
        <InvitationLink key={invitation.url} invitation={invitation} onClose={() => setInvitation(null)} />
      )}
      <CreateUserForm
        client={client}
        authMode={authMode}
        onCreated={(created) => {
          setNotice(null);
          setInvitation(created);
          reload();
        }}
      />
      <ul className="users">
        {users.map((user) => (
          <UserRow
            key={user.id}
            client={client}
            user={user}
            authMode={authMode}
            isCurrentUser={user.id === currentUserId}
            isLastAdmin={user.role === "admin" && users.filter((other) => other.role === "admin").length === 1}
            onNotice={showNotice}
            onInvitation={setInvitation}
            onReload={reload}
          />
        ))}
      </ul>
    </main>
  );
}

// The invitation link with a button to copy it. The clipboard API is missing outside secure contexts and can reject,
// for example when the permission is denied; then the link is selected to be copied by hand.
function InvitationLink({ invitation, onClose }: { invitation: IssuedInvitation; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  // The result of copying is about this link: a new link mounts a new component (key in UsersView).
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  async function onCopy() {
    setCopy("idle");
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("no clipboard API");
      await navigator.clipboard.writeText(invitation.url);
      setCopy("copied");
    } catch {
      setCopy("failed");
      input.current?.select();
    }
  }

  return (
    <div className="notice invitation-link" role="status">
      <p>
        {invitation.label} の招待リンクを発行しました。{formatDateTime(invitation.expiresAt)}{" "}
        まで、1&nbsp;回だけ使えます。このリンクは再表示できないので、今コピーして本人に伝えてください。
      </p>
      <input
        ref={input}
        type="text"
        readOnly
        value={invitation.url}
        aria-label="招待リンク"
        onFocus={(event) => event.currentTarget.select()}
      />
      <div className="invitation-link-actions">
        <button type="button" onClick={() => void onCopy()}>
          コピー
        </button>
        <button type="button" onClick={onClose}>
          閉じる
        </button>
        {copy === "copied" && <span>コピーしました</span>}
      </div>
      {copy === "failed" && <p role="alert">コピーできませんでした。選択されたリンクを手動でコピーしてください</p>}
    </div>
  );
}

// In password mode, a blank password invites the user with a link. In oidc mode, there is no password: the user
// signs in with the IdP.
function CreateUserForm({
  client,
  authMode,
  onCreated,
}: {
  client: ApiClient;
  authMode: AuthMode;
  onCreated: (invitation: IssuedInvitation | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");

  function openForm() {
    setOpen(true);
    setFailure(null);
    setEmail("");
    setName("");
    setPassword("");
    setRole("member");
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    // A blank name is sent as null; the server also treats it as no name. A blank password is not sent.
    const input: CreateUserRequest = { email, name: name.trim() === "" ? null : name, role };
    if (authMode === "password" && password !== "") input.password = password;
    const result = await createUser(client, input);
    switch (result.kind) {
      case "ok": {
        setSending(false);
        setOpen(false);
        const issued = result.user.invitation;
        onCreated(
          issued === null
            ? null
            : { label: userLabel(result.user), url: issued.url, expiresAt: issued.expires_at },
        );
        return;
      }
      case "error":
        setSending(false);
        setFailure(result.message);
        return;
      case "unknown":
        setSending(false);
        setFailure(UNKNOWN_RESULT_MESSAGE);
        return;
      case "redirecting":
        // The move to the login page has started; the buttons stay disabled.
        return;
    }
  }

  if (!open) {
    return (
      <div className="actions">
        <button type="button" className="button-primary" onClick={openForm}>
          <PlusIcon />
          ユーザーを追加
        </button>
      </div>
    );
  }
  return (
    <form className="folder-form" aria-label="ユーザーを追加" onSubmit={(event) => void onSubmit(event)}>
      <label>
        メールアドレス
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="off"
          required
          disabled={sending}
        />
      </label>
      <label>
        名前（省略可）
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} disabled={sending} />
      </label>
      {authMode === "password" && (
        <>
          <label>
            パスワード（12&nbsp;文字以上・省略可）
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              disabled={sending}
            />
          </label>
          <p className="form-hint">空欄にすると、本人がパスワードを決めるための招待リンクを発行します</p>
        </>
      )}
      <label>
        ロール
        <select value={role} onChange={(event) => setRole(event.target.value as Role)} disabled={sending}>
          <option value="member">{ROLE_LABELS.member}</option>
          <option value="admin">{ROLE_LABELS.admin}</option>
        </select>
      </label>
      {authMode === "oidc" && (
        <p className="form-hint">追加した人は、このメールアドレスで IdP にログインすると使えるようになります</p>
      )}
      <div className="folder-form-actions">
        <button type="submit" disabled={sending}>
          追加
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={sending}>
          やめる
        </button>
      </div>
      {failure !== null && <p role="alert">{failure}</p>}
    </form>
  );
}

// One user with the operations on them. One operation is open at a time.
function UserRow({
  client,
  user,
  authMode,
  isCurrentUser,
  isLastAdmin,
  onNotice,
  onInvitation,
  onReload,
}: {
  client: ApiClient;
  user: User;
  authMode: AuthMode;
  isCurrentUser: boolean;
  // The server refuses to make the last admin a member, so the button is not shown for them.
  isLastAdmin: boolean;
  onNotice: (notice: string | null) => void;
  onInvitation: (invitation: IssuedInvitation) => void;
  onReload: () => void;
}) {
  const [open, setOpen] = useState<Operation | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const newRole: Role = user.role === "admin" ? "member" : "admin";
  // Invited and never signed in. After a change of AUTH_MODE, a user who has signed in before can be "invited"
  // (no password, or no OIDC identity yet); they are not shown as invited.
  const isPendingInvitation = user.status === "invited" && user.last_login_at === null;
  const managesPassword = authMode === "password" && !isCurrentUser;
  // The operations on passwords and MFA are for password mode only; the current user changes their own
  // password and MFA elsewhere. A new invitation link is for a user without a password; an MFA reset is for
  // a user who can sign in.
  const operations: Operation[] = [
    ...(isLastAdmin ? [] : (["role"] as const)),
    ...(managesPassword && user.status === "invited" ? (["invite"] as const) : []),
    ...(managesPassword ? (["password"] as const) : []),
    ...(managesPassword && user.status === "active" ? (["mfa"] as const) : []),
    ...(isCurrentUser ? [] : (["logout", "delete"] as const)),
  ];

  function openOperation(operation: Operation) {
    setOpen(operation);
    setFailure(null);
    setPassword("");
    setConfirmation("");
  }

  async function run(operation: Operation, call: () => Promise<UserActionResult | IssueInvitationResult>) {
    setSending(true);
    setFailure(null);
    onNotice(null);
    const result = await call();
    switch (result.kind) {
      case "ok":
        // A new invitation link is shown in place of a notice.
        if ("invitation" in result) {
          setSending(false);
          setOpen(null);
          onInvitation({
            label: userLabel(user),
            url: result.invitation.url,
            expiresAt: result.invitation.expires_at,
          });
          onReload();
          return;
        }
        // The screen is for admins only and the signed-in user is loaded once, so start again from the top.
        if (operation === "role" && isCurrentUser && newRole === "member") {
          location.assign("/");
          return;
        }
        setSending(false);
        setOpen(null);
        onNotice(SUCCESS_MESSAGES[operation]?.(userLabel(user)) ?? null);
        onReload();
        return;
      case "notFound":
        setSending(false);
        setOpen(null);
        onNotice(GONE_MESSAGE);
        onReload();
        return;
      case "error":
        setSending(false);
        setFailure(result.message);
        return;
      case "unknown":
        setSending(false);
        setFailure(UNKNOWN_RESULT_MESSAGE);
        return;
      case "redirecting":
        // The move to the login page has started; the buttons stay disabled.
        return;
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    switch (open) {
      case "role":
        void run("role", () => changeUserRole(client, user.id, newRole));
        return;
      case "invite":
        void run("invite", () => issueInvitation(client, user.id));
        return;
      case "password":
        void run("password", () => resetUserPassword(client, user.id, password));
        return;
      case "mfa":
        void run("mfa", () => resetUserMfa(client, user.id));
        return;
      case "logout":
        void run("logout", () => revokeUserSessions(client, user.id));
        return;
      case "delete":
        if (confirmation !== user.email) return;
        void run("delete", () => deleteUser(client, user.id));
        return;
      case null:
        return;
    }
  }

  const operationLabel = (operation: Operation) =>
    operation === "role" ? (newRole === "admin" ? "管理者にする" : "一般に戻す") : OPERATION_LABELS[operation];

  return (
    <li>
      <div className="user-head">
        <span className="user-name">
          {user.name ?? <span className="user-unnamed">名前未設定</span>}
          {isCurrentUser && "（自分）"}
        </span>
        <span className="space-kind">{ROLE_LABELS[user.role]}</span>
        {isPendingInvitation && <span className="space-kind">招待中</span>}
      </div>
      <div className="user-detail">
        <span>{user.email}</span>
        <time dateTime={new Date(user.created_at).toISOString()}>作成: {formatDateTime(user.created_at)}</time>
        {user.last_login_at === null ? (
          <span>最終ログイン: 未ログイン</span>
        ) : (
          <time dateTime={new Date(user.last_login_at).toISOString()}>
            最終ログイン: {formatDateTime(user.last_login_at)}
          </time>
        )}
      </div>
      <div className="actions">
        {operations.map((operation) => (
          <button
            key={operation}
            type="button"
            // Deleting cannot be undone: it is set apart from the other operations.
            className={operation === "delete" ? "button-danger-outline" : undefined}
            onClick={() => openOperation(operation)}
            disabled={sending}
          >
            {operationLabel(operation)}
          </button>
        ))}
      </div>
      {open !== null && (
        <form className="folder-form" aria-label={operationLabel(open)} onSubmit={onSubmit}>
          {open === "role" && (
            <p>
              {newRole === "admin"
                ? `${userLabel(user)} を管理者にします。`
                : `${userLabel(user)} を一般に戻します。最後の管理者は戻せません。`}
              {isCurrentUser && newRole === "member" && "自分を一般に戻すと、この画面は使えなくなります。"}
            </p>
          )}
          {open === "invite" && <p>新しい招待リンクを発行します。前に発行したリンクは使えなくなります。</p>}
          {open === "password" && (
            <>
              <label>
                新しいパスワード（12&nbsp;文字以上）
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  disabled={sending}
                />
              </label>
              <p>このユーザーはすべての端末でログアウトし、MCP&nbsp;の接続も切れます。</p>
            </>
          )}
          {open === "mfa" && (
            <p>
              {userLabel(user)}{" "}
              の多要素認証（パスキー・認証アプリ・リカバリーコード）をすべて削除し、すべての端末でログアウトさせます。MCP&nbsp;の接続も切れます。リセット後はパスワードだけで新しい認証方法を登録できるので、本人確認をしてから実行し、すぐにログインして登録してもらってください。
            </p>
          )}
          {open === "logout" && <p>このユーザーをすべての端末でログアウトさせます。MCP&nbsp;の接続も切れます。</p>}
          {open === "delete" && (
            <>
              <p>
                {userLabel(user)}{" "}
                を削除します。元に戻せません。このユーザーの個人スペースと、その中のページ（ゴミ箱のページを含む）、フォルダ、添付ファイルも削除されます。ほかのスペースでこのユーザーが書いたページは残ります。
              </p>
              {isPendingInvitation && <p>まだログインしていないので、招待の取り消しになります。</p>}
              <label>
                確認のため、このユーザーのメールアドレスを入力してください
                <input
                  type="text"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  disabled={sending}
                />
              </label>
            </>
          )}
          <div className="folder-form-actions">
            <button
              type="submit"
              className={open === "delete" ? "button-danger" : undefined}
              disabled={sending || (open === "delete" && confirmation !== user.email)}
            >
              {SUBMIT_LABELS[open]}
            </button>
            <button type="button" onClick={() => setOpen(null)} disabled={sending}>
              やめる
            </button>
          </div>
          {failure !== null && <p role="alert">{failure}</p>}
        </form>
      )}
    </li>
  );
}

function userLabel(user: User): string {
  return user.name === null ? user.email : `${user.name}（${user.email}）`;
}

const OPERATION_LABELS: Record<Exclude<Operation, "role">, string> = {
  invite: "招待リンクを再発行",
  password: "パスワードを再設定",
  mfa: "多要素認証をリセット",
  logout: "ログアウトさせる",
  delete: "削除",
};

const SUBMIT_LABELS: Record<Operation, string> = {
  role: "変更",
  invite: "発行",
  password: "再設定",
  mfa: "リセット",
  logout: "ログアウトさせる",
  delete: "削除",
};

// The notice after an operation whose result does not show in the list.
const SUCCESS_MESSAGES: Partial<Record<Operation, (label: string) => string>> = {
  password: (label) => `${label} のパスワードを再設定しました`,
  mfa: (label) => `${label} の多要素認証をリセットしました`,
  logout: (label) => `${label} をログアウトさせました`,
  delete: (label) => `${label} を削除しました`,
};
