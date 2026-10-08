import { createFileRoute } from "@tanstack/react-router";
import { HuntApp } from "@/components/hunt/HuntApp";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <HuntApp />;
}
