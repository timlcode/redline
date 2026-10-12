// electron-builder afterPack hook: strip onnxruntime-node's native binaries
// for every platform except the one we are packaging, so the installer stays small.
// onnxruntime-node ships linux/darwin/win32 × x64/arm64 (~548 MB) regardless of host.
import fs from "node:fs";
import path from "node:path";

function keepArch(arch) {
  return arch === "arm64" ? "arm64" : "x64";
}

export default async function afterPack(context) {
  const platform = context.electronPlatformName; // "linux" | "darwin" | "win32" | "mas"
  const arch = keepArch(process.arch);
  const candidates = [
    path.join(context.appOutDir, "node_modules", "onnxruntime-node", "bin"),
    path.join(context.appOutDir, "resources", "app", "node_modules", "onnxruntime-node", "bin"),
  ];
  const root = candidates.find((c) => fs.existsSync(c));
  if (!root) {
    console.log("[afterPack] onnxruntime bin not found; skipped pruning");
    return;
  }
  let removed = 0;
  for (const api of fs.readdirSync(root)) {
    const apiDir = path.join(root, api);
    if (!fs.statSync(apiDir).isDirectory()) continue;
    for (const plat of fs.readdirSync(apiDir)) {
      const platDir = path.join(apiDir, plat);
      if (!fs.statSync(platDir).isDirectory()) continue;
      if (plat !== platform) {
        fs.rmSync(platDir, { recursive: true, force: true });
        removed++;
        continue;
      }
      for (const a of fs.readdirSync(platDir)) {
        if (a !== arch) {
          fs.rmSync(path.join(platDir, a), { recursive: true, force: true });
          removed++;
        }
      }
      // Strip GPU/accelerator provider libs (CUDA/TensorRT/DirectML/etc.). Redline's OCR
      // runs on the CPU execution provider, so these are dead weight (CUDA alone is ~260 MB).
      const kept = path.join(platDir, arch);
      for (const f of fs.readdirSync(kept)) {
        if (/^libonnxruntime_providers_/i.test(f) && !/providers_shared/i.test(f)) {
          fs.rmSync(path.join(kept, f), { force: true });
          removed++;
        }
      }
    }
  }
  console.log(`[afterPack] pruned onnxruntime for ${platform}/${arch}; removed ${removed} dir(s)`);
}
