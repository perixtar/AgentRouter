"use client";

import { useFormStatus } from "react-dom";

import { signOutAction } from "./actions";

function initials(email: string): string {
  const local = email.split("@")[0] ?? email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = (parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : local.slice(0, 2)) || "AR";
  return letters.toUpperCase();
}

function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="iconbtn"
      title="Sign out"
      aria-label="Sign out"
      disabled={pending}
    >
      <svg
        className="svg"
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
      </svg>
    </button>
  );
}

export function AccountFooter({
  email,
  orgName
}: {
  email: string;
  orgName: string;
}) {
  return (
    <div
      className="account"
      style={{ cursor: "default", justifyContent: "space-between" }}
    >
      <div className="avatar">{initials(email)}</div>
      <div style={{ flex: 1, textAlign: "left", lineHeight: 1.2, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 540,
            color: "var(--tx)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
          }}
        >
          {orgName}
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--tx-4)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
          }}
        >
          {email}
        </div>
      </div>
      <form action={signOutAction}>
        <SignOutButton />
      </form>
    </div>
  );
}
