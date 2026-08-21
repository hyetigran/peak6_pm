import { redirect } from "next/navigation";

// The design opens directly on Markets (no separate landing page in the
// mockups). Root redirects there.
export default function Home() {
  redirect("/markets");
}
