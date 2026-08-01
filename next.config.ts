import type { NextConfig } from "next";

/** FritzBox-/Heimnetz-IPs für iPhone-HMR und Server Actions im LAN. */
const lanHosts = Array.from({ length: 254 }, (_, i) => `192.168.178.${i + 1}`);

const nextConfig: NextConfig = {
  // Lokal oft per LAN-IP (iPhone) — sonst HMR/Dev-Assets blockiert.
  allowedDevOrigins: ["127.0.0.1", "localhost", ...lanHosts],
  experimental: {
    serverActions: {
      bodySizeLimit: "105mb",
      allowedOrigins: [
        "localhost:3003",
        "127.0.0.1:3003",
        ...lanHosts.map((h) => `${h}:3003`),
      ],
    },
  },
};

export default nextConfig;
