import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.argv[2] || process.env.npm_package_version;

if (!targetVersion) {
    throw new Error("Missing target version.");
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = targetVersion;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
