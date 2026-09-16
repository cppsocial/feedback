import { build } from "esbuild";
import { cp, readFile, rm, writeFile } from "node:fs/promises";

await rm("dist", { force: true, recursive: true });

const common = {
  bundle: true,
  loader: { ".graphql": "text" },
  entryPoints: ["src/index.ts"],
  entryNames: "feedback.[hash]",
  legalComments: "none",
  minify: true,
  outdir: "dist/pages/v1",
  sourcemap: true,
  target: "es2022",
};

const [, , esm, iife, callback, example] = await Promise.all([
  build({
    bundle: true,
    entryPoints: ["src/callback/page.ts"],
    format: "iife",
    legalComments: "none",
    loader: { ".graphql": "text" },
    minify: true,
    outfile: "dist/package/oauth/callback.js",
    platform: "browser",
    target: "es2022",
  }),
  build({
    bundle: true,
    entryPoints: ["src/index.ts"],
    format: "esm",
    legalComments: "none",
    loader: { ".graphql": "text" },
    outfile: "dist/package/index.js",
    platform: "browser",
    sourcemap: true,
    target: "es2022",
  }),
  build({ ...common, format: "esm", metafile: true, outExtension: { ".js": ".mjs" } }),
  build({ ...common, format: "iife", globalName: "CppSocialFeedback", metafile: true }),
  build({
    ...common,
    entryNames: "oauth/callback.[hash]",
    entryPoints: ["src/callback/page.ts"],
    format: "iife",
    metafile: true,
    sourcemap: false,
  }),
  build({
    ...common,
    entryNames: "example/example.[hash]",
    entryPoints: ["src/example/page.ts"],
    format: "iife",
    metafile: true,
    outdir: "dist/pages",
    sourcemap: false,
  }),
]);

const relativeOutput = (result, suffix) => {
  const output = Object.keys(result.metafile.outputs).find((name) => name.endsWith(suffix));
  if (!output) throw new Error(`Missing ${suffix} build output`);
  return output.replace(/^dist\/pages\//, "");
};

const esmFile = relativeOutput(esm, ".mjs");
const iifeFile = relativeOutput(iife, ".js");
const callbackFile = relativeOutput(callback, ".js");
const exampleFile = relativeOutput(example, ".js");
await cp("pages", "dist/pages", { recursive: true });
await renderPage("assets/oauth/callback.html", "dist/package/oauth/callback.html", {
  CALLBACK_SCRIPT: "./callback.js",
});
await renderPage("assets/oauth/callback.html", "dist/pages/v1/oauth/callback.html", {
  CALLBACK_SCRIPT: `/${callbackFile}`,
});
await renderPage("pages/example/index.html", "dist/pages/example/index.html", {
  EXAMPLE_SCRIPT: `/${exampleFile}`,
});
await writeFile(
  "dist/pages/v1/manifest.json",
  JSON.stringify({
    version: 1,
    esm: `/${esmFile}`,
    iife: `/${iifeFile}`,
    callback: "/v1/oauth/callback.html",
    example: "/example/",
  }),
);

async function renderPage(source, destination, replacements) {
  let content = await readFile(source, "utf8");
  for (const [name, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${name}}}`, value);
  }
  await writeFile(destination, content);
}
