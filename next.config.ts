import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  env: { dashboardMode: "server", dashboardBasePath: "" },
};

export default nextConfig;
