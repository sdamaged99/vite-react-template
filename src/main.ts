import "./styles/main.css";

// Mobile navigation toggle. No framework on the marketing page: React loads
// only when an island mount point is present (see below), keeping the public
// site fast and fully crawlable.
const toggle = document.getElementById("nav-toggle");
const menu = document.getElementById("mobile-nav");
if (toggle && menu) {
  toggle.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  });
  menu.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a")) {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    }
  });
}

// Island loader: Phase 2 mounts the availability calendar here. The dynamic
// import means React is only fetched on pages that actually use it.
const availabilityMount = document.getElementById("island-availability");
if (availabilityMount && availabilityMount.dataset.enabled === "true") {
  import("./islands/availability").then((m) => m.mount(availabilityMount));
}
