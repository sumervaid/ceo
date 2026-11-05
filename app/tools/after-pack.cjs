// With no Developer ID, an ad-hoc signature keeps an Apple Silicon build runnable on this machine.
// A release build with CSC_LINK set is signed and notarized by electron-builder instead.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== "darwin" || process.env.CSC_LINK) return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" });
};
