import { loginAction } from "../actions";
import { AuthForm } from "../auth-form";

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return <AuthForm mode="login" action={loginAction} next={next ?? "/playground"} />;
}
