import { redirect } from "next/navigation";

// Until the Today screen is built, the office opens on its customers.
export default function Home() {
  redirect("/customers");
}
