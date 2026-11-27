import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import createMDX from "@next/mdx";

const withMDX = createMDX();

// Every docs page also answers at its bare slug (`/x` redirects to `/docs/x`), the
// address each service manifest advertises as its docsUrl. Read from the docs
// folders so a new service's page is reachable without editing a list.
const docsDir = fileURLToPath(new URL("./app/docs/", import.meta.url));
const docsSlugs = readdirSync(docsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ["ts", "tsx", "md", "mdx"],
  serverExternalPackages: ["just-bash", "bash-tool"],
  images: {
    unoptimized: true,
  },
  async redirects() {
    return docsSlugs.map((slug) => ({
      source: `/${slug}`,
      destination: `/docs/${slug}`,
      permanent: true,
    }));
  },
};

export default withMDX(nextConfig);
