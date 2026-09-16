import { access, readFile } from "node:fs/promises";

const callback = await readFile("dist/package/oauth/callback.html", "utf8");
if (!callback.includes('<script src="./callback.js"></script>')) {
  throw new Error("Packaged callback does not load its bundled script");
}

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const required = [
  manifest.exports?.["."]?.import,
  manifest.exports?.["."]?.types,
  manifest.exports?.["./oauth/callback.html"],
  manifest.exports?.["./oauth/callback.js"],
];

for (const path of required) {
  if (typeof path !== "string" || !path.startsWith("./dist/package/")) {
    throw new Error("Package export is missing or leaves the package output");
  }
  await access(path);
}
