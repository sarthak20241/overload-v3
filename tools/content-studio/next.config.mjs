/** @type {import('next').NextConfig} */
const nextConfig = {
  // The studio runs on your own machine only. It shells out to the Claude CLI
  // and holds your social tokens, so it must never be deployed anywhere.
  poweredByHeader: false,
};
export default nextConfig;
