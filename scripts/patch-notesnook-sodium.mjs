import { readFile, writeFile } from "node:fs/promises";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Usage: patch-notesnook-sodium.mjs <sodium src/node.ts>");

let source = await readFile(sourcePath, "utf8");
if (source.includes('import sodiumNative from "sodium-native";')) {
  console.log("Notesnook sodium CJS interop patch already applied.");
} else {
  const match = source.match(/import \{([\s\S]*?)\} from "sodium-native";/);
  if (!match) throw new Error(`Could not find the sodium-native named import in ${sourcePath}`);

  const bindings = match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [imported, alias] = item.split(/\s+as\s+/);
      return alias ? `${imported}: ${alias}` : imported;
    });
  const replacement = [
    'import sodiumNative from "sodium-native";',
    "",
    "const {",
    ...bindings.map((binding) => `  ${binding},`),
    "} = sodiumNative;"
  ].join("\n");

  source = source.replace(match[0], replacement);
  await writeFile(sourcePath, source);
  console.log("Applied Notesnook sodium CJS interop patch.");
}
