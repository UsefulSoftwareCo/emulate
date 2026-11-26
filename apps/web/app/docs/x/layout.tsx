import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("x");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
