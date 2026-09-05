import type { NextConfig } from "next";
import path from "node:path";

// Documentation has no API proxy, account session, or workspace dependency.
const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
};
export default nextConfig;
