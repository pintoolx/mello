import type { ReactNode } from "react";
import { MelloConsole } from "@/components/mello-console";
import { SessionGate } from "@/components/workspace/session";

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  // Keep one session-scoped shell and one settings/controls/health read loop.
  // MelloConsole keys its page content by pathname, not the shared resources.
  return (
    <SessionGate>
      <MelloConsole />
      {children}
    </SessionGate>
  );
}
