import fs from "node:fs";
import path from "node:path";
import { parseFmkoreaHtml } from "../src/parsers/fmkorea";

const fixturePath = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "fmkorea-10256359178.html"
);

const html = fs.readFileSync(fixturePath, "utf-8");

const result = parseFmkoreaHtml(html, {
  sourceUrl: "https://www.fmkorea.com/10256359178",
});

console.log(JSON.stringify(result, null, 2));