/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@roaspy/shared"],
  // React StrictMode double-invokes effects in dev (mount → cleanup →
  // mount again) to surface missing-cleanup bugs. BatchDetailView's
  // EventSource effect already cleans up correctly, so this was just
  // opening a second, short-lived SSE connection (and a second
  // reconcile() fetch) on every batch page load in dev — harmless but
  // makes network traffic during manual testing confusing to read.
  reactStrictMode: false,
};

export default nextConfig;
