import { redirect } from "next/navigation";

// The office opens on Today.
export default function Home() {
  redirect("/today");
}
