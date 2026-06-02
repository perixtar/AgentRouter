"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  {
    href: "/playground",
    label: "Playground",
    icon: (
      <svg
        className="svg ic"
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 12h4l2 6 4-14 2 8h6" />
      </svg>
    )
  },
  {
    href: "/keys",
    label: "API Keys",
    icon: (
      <svg
        className="svg ic"
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 9a4 4 0 10-3.5 3.97L11 14l2 0 0 2 2 0 0 2 2.5 0 0-2.5L14 12.5A4 4 0 0014 9z" />
      </svg>
    )
  }
] as const;

export function SidebarNav() {
  const pathname = usePathname();
  return (
    <nav className="nav">
      {NAV.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`nav-item${active ? " on" : ""}`}
          >
            {item.icon}
            <span style={{ flex: 1 }}>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
