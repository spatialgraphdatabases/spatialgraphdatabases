// Content-hash first-party CSS/JS so `?v=<hash>` cache-busts on every deploy.
// Each key holds a 10-char sha1 slice of the source file's contents (plus any
// @import partials it pulls in). Referenced in templates as `{{ assets.<key> }}`.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..");

function read(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// Hash a file's contents combined with any local @import partials it references,
// so editing an imported partial changes the parent's hash too.
function hashAsset(relPath) {
  const abs = path.join(SRC, relPath);
  let combined = read(abs);
  const dir = path.dirname(abs);
  const importRe = /@import\s+(?:url\()?["']?([^"')]+)["']?\)?/g;
  let m;
  while ((m = importRe.exec(combined)) !== null) {
    const ref = m[1].trim();
    if (/^https?:\/\//i.test(ref) || ref.startsWith("//")) continue; // remote — skip
    combined += read(path.join(dir, ref));
  }
  return crypto.createHash("sha1").update(combined).digest("hex").slice(0, 10);
}

module.exports = {
  mainCss: hashAsset("assets/css/main.css"),
  siteJs: hashAsset("assets/js/site.js"),
};
