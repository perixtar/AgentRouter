"use client";

import { usePathname } from "next/navigation";

const TITLES: Record<string, string> = {
  "/playground": "Playground",
  "/keys": "API Keys"
};

export function PageTitle() {
  const pathname = usePathname();
  const key = Object.keys(TITLES).find((p) => pathname.startsWith(p));
  const title = key ? TITLES[key] : "AgentRouter";
  return <h1 className="title">{title}</h1>;
}
