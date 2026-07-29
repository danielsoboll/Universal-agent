import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Match private bucket limit (100 MiB) with a small buffer.
      bodySizeLimit: "105mb",
    },
  },
};

export default nextConfig;
