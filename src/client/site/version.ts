// The footer's version stamp, read from the health endpoint. Shared by the
// games page and the build page.

/** showVersion fills #version with the deployed version, if it can. */
export function showVersion(): void {
  fetch("/api/v1/health")
    .then((r) => r.json())
    .then((h) => {
      const el = document.getElementById("version");
      if (el) el.textContent = `v${(h as { version: string }).version}`;
    })
    .catch(() => {});
}
