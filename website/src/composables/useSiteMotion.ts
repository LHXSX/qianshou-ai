import { onMounted, onUnmounted, watch, type Ref } from "vue";

/** Section motion is visible-only; content remains readable without animation support. */
export function useSiteMotion(
  root: Ref<HTMLElement | undefined>,
  paused: Ref<boolean>,
) {
  let observer: IntersectionObserver | undefined;
  const motionPolicy = matchMedia("(prefers-reduced-motion: reduce)");
  const svgs = new Set<SVGSVGElement>();
  function syncSvg(section: Element, active: boolean) {
    section.querySelectorAll("svg").forEach((svg) => {
      if (!svg.querySelector("animateMotion, animate, animateTransform"))
        return;
      svgs.add(svg);
      try {
        active && !paused.value && !motionPolicy.matches && !document.hidden
          ? svg.unpauseAnimations()
          : svg.pauseAnimations();
      } catch {
        /* Static SVG remains usable. */
      }
    });
  }
  function syncAll() {
    root.value
      ?.querySelectorAll("[data-motion-section]")
      .forEach((section) =>
        syncSvg(section, section.classList.contains("is-visible")),
      );
  }
  const stop = watch(paused, syncAll);
  onMounted(() => {
    const host = root.value;
    if (!host) return;
    motionPolicy.addEventListener("change", syncAll);
    document.addEventListener("visibilitychange", syncAll);
    observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          entry.target.classList.toggle("is-visible", entry.isIntersecting);
          if (entry.isIntersecting) entry.target.classList.add("has-entered");
          syncSvg(entry.target, entry.isIntersecting);
        }),
      { threshold: 0.08 },
    );
    host
      .querySelectorAll(".qs-section, .metrics-bar, .closing-section")
      .forEach((section) => {
        section.setAttribute("data-motion-section", "");
        observer!.observe(section);
        syncSvg(section, false);
      });
  });
  onUnmounted(() => {
    stop();
    motionPolicy.removeEventListener("change", syncAll);
    document.removeEventListener("visibilitychange", syncAll);
    observer?.disconnect();
    svgs.forEach((svg) => {
      try {
        svg.pauseAnimations();
      } catch {}
    });
    svgs.clear();
  });
}
