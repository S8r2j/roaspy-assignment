/** API base URL for server-side code (Server Components, route handlers).
 * These run inside the Docker network and must reach the API via its
 * service name (`http://api:3001` in compose), not `localhost`. */
export const API_BASE_INTERNAL = process.env.API_BASE_INTERNAL ?? "http://localhost:3001";

/** API base URL for client-side code (the browser). Runs outside the
 * Docker network and needs a host-reachable URL — deliberately a
 * different value from `API_BASE_INTERNAL`, not one shared constant. */
export const API_BASE_PUBLIC = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

/** Returns the correct API base URL for whichever environment is calling
 * it — `API_BASE_INTERNAL` during server-side rendering, `API_BASE_PUBLIC`
 * in the browser. Use this in Server Components; client components should
 * import `API_BASE_PUBLIC` directly, since they only ever run in the
 * browser. */
export function apiBase(): string {
  return typeof window === "undefined" ? API_BASE_INTERNAL : API_BASE_PUBLIC;
}
