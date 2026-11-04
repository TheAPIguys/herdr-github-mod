import { exec, notify } from "herdr";
import { safeUrl } from "./urls.js";

/** Open validated HTTPS links locally and report browser-launch failures. */
export async function openUrl(url) {
  const safe = safeUrl(url);
  if (!safe) return;
  try {
    // xdg-open does not accept --; validated HTTPS URLs cannot be options.
    const result = await exec("xdg-open", [safe]);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || "xdg-open failed").trim());
  } catch (error) {
    notify({ title: "Could not open browser", body: String(error.message ?? error), level: "error" });
  }
}
