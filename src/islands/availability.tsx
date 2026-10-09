import { createRoot } from "react-dom/client";

/**
 * Phase 2: availability calendar island.
 * Will fetch /api/availability and render the booking request flow
 * (dates → duration → add-ons → contact details → terms → request).
 * Mounted only when #island-availability has data-enabled="true".
 */
function Availability() {
  return (
    <p className="text-sm text-ink-soft">
      Availability calendar placeholder (Phase 2).
    </p>
  );
}

export function mount(el: HTMLElement) {
  createRoot(el).render(<Availability />);
}
