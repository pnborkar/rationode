import { resetAll } from "@/lib/stories";

export async function POST() {
  return Response.json(await resetAll());
}
