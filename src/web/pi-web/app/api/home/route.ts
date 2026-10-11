import { NextResponse } from "../../../../shims/next-server.js";
import { homedir } from "os";

export async function GET() {
  return NextResponse.json({ home: homedir() });
}
