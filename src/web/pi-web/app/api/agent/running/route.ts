import { NextResponse } from "../../../../../shims/next-server.js";
import { getSessionListVersion } from "../../../../lib/session-reader.js";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "../../../../lib/rpc-manager.js";
import { getSessionUiStateRevision } from "../../../../lib/session-ui-state.js";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// sessionUiStateRevision (null when unreadable) tells the sidebar its pins and
// archive changed elsewhere; it costs one stat while the file is unchanged.
export async function GET() {
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: getRunningRpcSessionIds(),
      awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      sessionUiStateRevision: getSessionUiStateRevision(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
