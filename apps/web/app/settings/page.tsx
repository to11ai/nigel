import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Settings",
  description: "Manage your Nigel account settings.",
};

export default function SettingsPage() {
  redirect("/settings/profile");
}
