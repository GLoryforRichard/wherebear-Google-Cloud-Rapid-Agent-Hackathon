import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Phone album shots are often 10–20 MB HEIC/JPEG. Next's proxy buffer
  // defaults to 10 MB and a truncated multipart then fails as FormData.
  experimental: {
    proxyClientMaxBodySize: '25mb',
    serverActions: { bodySizeLimit: '25mb' },
  },
};

export default nextConfig;
