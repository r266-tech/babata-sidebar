export function smokeExtensionId() {
  const id = (process.env.BABATA_EXTENSION_ID || "").trim();
  if (!/^[a-p]{32}$/.test(id)) {
    throw new Error("Set BABATA_EXTENSION_ID to the extension ID shown in chrome://extensions or edge://extensions before running a manual smoke test.");
  }
  return id;
}
