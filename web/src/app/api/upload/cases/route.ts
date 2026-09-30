import { uploadedCases } from "@/lib/uploads";
import { withTenant } from "@/lib/tenant";

async function GET_() {
  return Response.json(await uploadedCases());
}

// Every request runs in its workspace (demo spec §23.9).
export const GET = withTenant(GET_);
