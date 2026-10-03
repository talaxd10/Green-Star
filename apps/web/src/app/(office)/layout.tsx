import type { ReactNode } from "react";
import { Shell } from "@/components/shell";

export default function OfficeLayout({ children }: { children: ReactNode }) {
  return <Shell>{children}</Shell>;
}
