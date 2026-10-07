export function restrictFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Notesnook requests require HTTPS without embedded credentials.");
    return fetchImpl(input, { ...init, redirect: "error" });
  };
}
