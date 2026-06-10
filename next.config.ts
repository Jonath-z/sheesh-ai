import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@anthropic-ai/claude-agent-sdk",
    "@resvg/resvg-js",
    "remotion",
    "@remotion/renderer",
    "@remotion/bundler",
  ],
  // Remotion compositions are a separate React entry; don't let Next try to crawl them.
  outputFileTracingExcludes: {
    "*": ["remotion/**"],
  },
};

export default nextConfig;
