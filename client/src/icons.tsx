import type { ReactNode } from "react";
import type { SpaceKind } from "../../src/api/types";

// Decorative icons drawn with the current text color. The text next to them names the thing, so screen
// readers skip them; an icon-only button gives itself an aria-label.
function Icon({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      className={className === undefined ? "icon" : `icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function FolderIcon() {
  return (
    <Icon>
      <path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4.4l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
    </Icon>
  );
}

export function PageIcon() {
  return (
    <Icon>
      <path d="M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
      <path d="M13.5 3.5v4h4" />
      <path d="M8.5 12.5h7M8.5 16h5" />
    </Icon>
  );
}

export function SearchIcon() {
  return (
    <Icon>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function EditIcon() {
  return (
    <Icon>
      <path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-4-4l-10 10z" />
      <path d="m13.5 6.5 4 4" />
    </Icon>
  );
}

export function HistoryIcon() {
  return (
    <Icon>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4.5v3.8h3.8" />
      <path d="M12 8v4.5l3 1.8" />
    </Icon>
  );
}

export function LinkIcon() {
  return (
    <Icon>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Icon>
  );
}

export function CopyIcon() {
  return (
    <Icon>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </Icon>
  );
}

// The Markdown mark: an "M" and a down arrow in a frame.
export function MarkdownIcon() {
  return (
    <Icon>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
      <path d="M6.5 15V9l2.5 3 2.5-3v6" />
      <path d="M16.5 9v6m-2-2 2 2 2-2" />
    </Icon>
  );
}

// Lines of text, for the text of a page body.
export function TextIcon() {
  return (
    <Icon>
      <path d="M4.5 6.5h15M4.5 10.5h15M4.5 14.5h15M4.5 18.5h9" />
    </Icon>
  );
}

export function CheckIcon() {
  return (
    <Icon>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function MoreIcon() {
  return (
    <Icon>
      <circle cx="5.5" cy="12" r="0.6" fill="currentColor" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
      <circle cx="18.5" cy="12" r="0.6" fill="currentColor" />
    </Icon>
  );
}

export function MoveIcon() {
  return (
    <Icon>
      <path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4.4l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
      <path d="M9 13.5h6M12.5 11l2.5 2.5-2.5 2.5" />
    </Icon>
  );
}

export function TrashIcon() {
  return (
    <Icon>
      <path d="M4.5 7h15M10 7V5h4v2" />
      <path d="M6.5 7l1 12.5h9l1-12.5" />
      <path d="M10.5 11v5M13.5 11v5" />
    </Icon>
  );
}

export function ArchiveIcon() {
  return (
    <Icon>
      <path d="M3.5 5.5a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1v2.5h-17z" />
      <path d="M5 8v10.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </Icon>
  );
}

export function UsersIcon() {
  return (
    <Icon>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8" />
      <path d="M15.5 5.8a3 3 0 0 1 0 5.4M17 14.5c1.9.6 3.1 2.2 3.5 4.5" />
    </Icon>
  );
}

export function LogoutIcon() {
  return (
    <Icon>
      <path d="M14 4.5H6.5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1H14" />
      <path d="M10.5 12h10M17 8.5l3.5 3.5-3.5 3.5" />
    </Icon>
  );
}

export function PinIcon() {
  return (
    <Icon>
      <path d="M9 3.5h6l-1 5.5 3.5 3.5v1.5h-11V12.5L10 9z" />
      <path d="M12 14v6.5" />
    </Icon>
  );
}

export function ChevronIcon() {
  return (
    <Icon className="icon-chevron">
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

// Opens the list of pages: a panel on the left side of a window.
export function SidebarIcon() {
  return (
    <Icon>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M9.5 4.5v15M5.5 8.5h2M5.5 11.5h2" />
    </Icon>
  );
}

export function ReloadIcon() {
  return (
    <Icon>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="m6 6 12 12M18 6 6 18" />
    </Icon>
  );
}

// Who can see a space: everyone, admins only, the chosen members, or the owner only.
export function SpaceKindIcon({ kind }: { kind: SpaceKind }) {
  switch (kind) {
    case "everyone":
      return <UsersIcon />;
    case "admin":
      return (
        <Icon>
          <rect x="5" y="10.5" width="14" height="9.5" rx="1.5" />
          <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
        </Icon>
      );
    case "members":
      // A person with a check mark: the users chosen for the space.
      return (
        <Icon>
          <circle cx="10" cy="8.5" r="3.5" />
          <path d="M3.5 20c.7-3.4 3.3-5.6 6.5-5.6 1.4 0 2.6.4 3.6 1.1" />
          <path d="m15 18 2 2 4-4.5" />
        </Icon>
      );
    case "personal":
      return (
        <Icon>
          <circle cx="12" cy="8.5" r="3.5" />
          <path d="M5 20c.8-3.6 3.6-5.8 7-5.8s6.2 2.2 7 5.8" />
        </Icon>
      );
  }
}
