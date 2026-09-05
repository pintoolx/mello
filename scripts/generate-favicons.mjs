// Compile the existing Figma vector into browser icons, without changing its paths.
// Each app receives its own static files; neither depends on the other at runtime.
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const mark = await readFile(new URL("apps/web/public/brand/mello-mark.svg", root), "utf8");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
<rect width="128" height="128" rx="12" fill="#f8f9f4"/>
<svg x="7" y="15" width="114" height="98" viewBox="0 0 120.877 103.609">
${mark.slice(mark.indexOf(">") + 1, mark.lastIndexOf("</svg>"))}
</svg>
</svg>
`;
const rasterize = (size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
const sizes = [16, 32, 48, 64];
const images = await Promise.all(sizes.map(rasterize));
// ICO directory followed by one PNG payload for each supported size.
const directory = Buffer.alloc(6 + images.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(images.length, 4);
let offset = directory.length;
images.forEach((png, index) => {
  const entry = 6 + index * 16;
  directory[entry] = sizes[index];
  directory[entry + 1] = sizes[index];
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(png.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
const ico = Buffer.concat([directory, ...images]);
const apple = await rasterize(180);
for (const app of ["web", "docs"]) {
  const directory = new URL(`apps/${app}/src/app/`, root);
  await Promise.all([
    writeFile(new URL("icon.svg", directory), svg),
    writeFile(new URL("icon.png", directory), images[3]),
    writeFile(new URL("favicon.ico", directory), ico),
    writeFile(new URL("apple-icon.png", directory), apple),
  ]);
  console.log(`${app}: SVG, 64px PNG, 16/32/48/64px ICO, 180px Apple icon`);
}
