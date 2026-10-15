import { createFileRoute } from "@tanstack/react-router";
import { FieldTestScreen } from "@/features/field-test/FieldTestScreen";

/**
 * Phone field-test tool (CC-01). Reached by its address or from Settings →
 * "Phone field test"; it doesn't change the map or the user's saved content.
 */
export const Route = createFileRoute("/field-test")({
  head: () => ({
    meta: [{ title: "Fieldline phone field test" }, { name: "robots", content: "noindex" }],
  }),
  component: FieldTest,
});

function FieldTest() {
  return <FieldTestScreen flavor="app" />;
}
