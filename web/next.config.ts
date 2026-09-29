import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A second copy of the app for another tenant (demo spec §21) runs beside the demo with its own build folder:
  // NEXT_DIST_DIR=.next-dbx RATIONODE_TENANT=dbx NEXT_PUBLIC_RATIONODE_TENANT=dbx npx next dev --port 3200
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
