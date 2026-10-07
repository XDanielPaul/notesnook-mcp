import type { openDatabase } from "./db.js";
import { validateHosts } from "./config.js";

type Db = Awaited<ReturnType<typeof openDatabase>>["db"];

export async function revokeSession(db: Pick<Db, "kv" | "user">, authHost: string) {
  const host = validateHosts({ API_HOST: authHost, AUTH_HOST: authHost, SSE_HOST: authHost }).AUTH_HOST;
  const token = await db.kv().read("token");
  if (!token?.access_token) {
    if (await db.user.getUser())
      throw new Error("The session token is missing; remote revocation cannot be confirmed.");
    return;
  }
  // Core's logout deletes the token before sending this request and swallows errors.
  const response = await fetch(`${host}/account/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.access_token}` },
    redirect: "error",
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok)
    throw new Error(`Session revocation failed (HTTP ${response.status}).`);
}
