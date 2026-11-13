import { useEffect, useState } from "react";
import type { User } from "../../../src/api/types";
import { type ApiClient, loadUserList } from "../load";
import type { Loadable } from "./MoveDestination";

// All the users, to choose members from. Loaded while enabled is true, again every time it becomes true.
// After "redirecting" the move to the login page has started, so the list stays loading.
export function useUserList(client: ApiClient, enabled: boolean): Loadable<User[]> {
  const [users, setUsers] = useState<Loadable<User[]>>({ kind: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setUsers({ kind: "loading" });
    void loadUserList(client).then((result) => {
      if (!cancelled) setUsers(result.kind === "redirecting" ? { kind: "loading" } : result);
    });
    return () => {
      cancelled = true;
    };
    // client does not change while the screen is shown.
  }, [enabled]);
  return users;
}

// The IDs in selected that are users in the list, in the order of the list. Members deleted while the editor
// was open are dropped, so that saving does not fail on them.
export function selectedUserIds(users: User[], selected: ReadonlySet<string>): string[] {
  return users.filter((user) => selected.has(user.id)).map((user) => user.id);
}

// Checkboxes of all the users, in the order of the API (creation order), to choose the members of a members
// space. The caller disables saving unless users is ok.
export function MemberPicker({
  users,
  selected,
  onChange,
  disabled,
}: {
  users: Loadable<User[]>;
  selected: ReadonlySet<string>;
  onChange: (selected: Set<string>) => void;
  disabled: boolean;
}) {
  function toggle(userId: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(userId);
    else next.delete(userId);
    onChange(next);
  }

  return (
    <fieldset className="member-picker">
      <legend>メンバー</legend>
      <p className="form-hint">管理者はメンバーに選ばなくても見られます。選んでおくと一般に戻したあとも見られます</p>
      {users.kind === "loading" && <p className="form-hint">読み込み中…</p>}
      {users.kind === "error" && <p role="alert">ユーザーを読み込めませんでした</p>}
      {users.kind === "ok" && (
        <ul className="member-choices">
          {users.value.map((user) => (
            <li key={user.id}>
              <label className="member-choice">
                <input
                  type="checkbox"
                  checked={selected.has(user.id)}
                  onChange={(event) => toggle(user.id, event.target.checked)}
                  disabled={disabled}
                />
                <span className="member-choice-text">
                  <span className="member-choice-name">
                    {user.name ?? user.email}
                    {user.role === "admin" && <span className="space-kind">管理者</span>}
                  </span>
                  {user.name !== null && <span className="member-choice-email">{user.email}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
