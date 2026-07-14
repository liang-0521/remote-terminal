import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VERSION_HEADING_PATTERN = /^##\s+\[?(v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\]?(?:\s+-\s+.*)?\s*$/;

function normalizeVersion(version) {
  if (typeof version !== "string") {
    throw new TypeError("Release version must be a string.");
  }
  const normalized = version.trim().replace(/^v/, "");
  if (!SEMVER_PATTERN.test(normalized)) {
    throw new Error(`Invalid release version '${version}'.`);
  }
  return normalized;
}

export function extractReleaseNotes(markdown, version) {
  if (typeof markdown !== "string") {
    throw new TypeError("CHANGELOG content must be a string.");
  }

  const expectedVersion = normalizeVersion(version);
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const matchingHeadings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(VERSION_HEADING_PATTERN);
    if (match && normalizeVersion(match[1]) === expectedVersion) {
      matchingHeadings.push(index);
    }
  }

  if (matchingHeadings.length === 0) {
    throw new Error(`CHANGELOG has no section for version ${expectedVersion}.`);
  }
  if (matchingHeadings.length > 1) {
    throw new Error(`CHANGELOG has multiple sections for version ${expectedVersion}.`);
  }

  const start = matchingHeadings[0] + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const notes = lines.slice(start, end).join("\n").trim();
  if (!notes) {
    throw new Error(`CHANGELOG section for version ${expectedVersion} is empty.`);
  }
  return notes;
}

function parseArguments(argv) {
  const options = { changelog: "CHANGELOG.md" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--changelog", "--version", "--output"].includes(argument)) {
      throw new Error(`Unknown argument '${argument}'.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for '${argument}'.`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.version) {
    throw new Error("Missing required --version argument.");
  }
  if (!options.output) {
    throw new Error("Missing required --output argument.");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const changelog = await readFile(resolve(options.changelog), "utf8");
  const notes = extractReleaseNotes(changelog, options.version);
  await writeFile(resolve(options.output), `${notes}\n`, "utf8");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
