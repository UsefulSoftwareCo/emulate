import { pageMetadata } from "@/lib/page-metadata";

export const metadata = pageMetadata("clerk");

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
