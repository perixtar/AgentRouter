import { redirect } from "next/navigation";

export default function Home() {
  // The shell lives under /playground; middleware gates it and redirects
  // unauthenticated visitors to /login.
  redirect("/playground");
}
