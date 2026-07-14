const syntaxHighlight = require("@11ty/eleventy-plugin-syntaxhighlight");
const eleventyNavigation = require("@11ty/eleventy-navigation");
const markdownIt = require("markdown-it");
const markdownItAnchor = require("markdown-it-anchor");
const markdownItAttrs = require("markdown-it-attrs");
const markdownItTaskLists = require("markdown-it-task-lists");

module.exports = function (eleventyConfig) {
  eleventyConfig.addPlugin(syntaxHighlight, {
    preAttributes: { tabindex: 0, "data-lang": ({ language }) => language || "" },
  });
  eleventyConfig.addPlugin(eleventyNavigation);

  // Pass-through copies
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });
  eleventyConfig.addPassthroughCopy({ "src/manifest.webmanifest": "manifest.webmanifest" });
  eleventyConfig.addPassthroughCopy({ "src/sw.js": "sw.js" });
  eleventyConfig.addPassthroughCopy({ "src/robots.txt": "robots.txt" });
  eleventyConfig.addPassthroughCopy({ "src/favicon.ico": "favicon.ico" });
  eleventyConfig.addPassthroughCopy({ "src/favicon.svg": "favicon.svg" });
  eleventyConfig.addPassthroughCopy({ "src/1317559966cfce5b2c9b6737b3fcdecc.txt": "1317559966cfce5b2c9b6737b3fcdecc.txt" });

  // Markdown
  const md = markdownIt({ html: true, linkify: true, typographer: true, breaks: false })
    .use(markdownItAnchor, {
      // Plain-text slug (no encodeURIComponent) so heading ids stay ASCII and
      // never contain %-escapes like %26 for "&". "Core Concept & Mechanism"
      // -> "core-concept-mechanism".
      slugify: (s) =>
        String(s)
          .trim()
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-+|-+$/g, ""),
      permalink: markdownItAnchor.permalink.headerLink({
        safariReaderFix: true,
      }),
    })
    .use(markdownItAttrs)
    .use(markdownItTaskLists, { enabled: true, label: true, lineNumber: false });

  // Defer ```mermaid blocks: render as <pre class="mermaid"> so client JS can detect & render.
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const info = (token.info || "").trim();
    if (info === "mermaid") {
      return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };

  // Wrap content tables in a horizontally-scrollable .table-wrapper so the table
  // itself keeps its default display:table layout (full-width cells) and overflow
  // is handled by the wrapper — never by forcing display:block onto the <table>.
  md.renderer.rules.table_open = function () {
    return '<div class="table-wrapper">\n<table>\n';
  };
  md.renderer.rules.table_close = function () {
    return '</table>\n</div>\n';
  };

  eleventyConfig.setLibrary("md", md);

  // Filters
  eleventyConfig.addFilter("readableDate", (d) =>
    new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
  );

  eleventyConfig.addFilter("titleFromContent", (content) => {
    const m = (content || "").match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : "";
  });

  // Filter collection by URL regex pattern
  eleventyConfig.addFilter("matchUrl", function (items, pattern) {
    if (!Array.isArray(items)) return [];
    const re = new RegExp(pattern);
    return items.filter((item) => item && item.url && re.test(item.url));
  });

  // Filter: items whose URL starts with given prefix and have only one extra path segment
  eleventyConfig.addFilter("directChildrenOf", function (items, prefix) {
    if (!Array.isArray(items) || !prefix) return [];
    return items.filter((item) => {
      if (!item || !item.url) return false;
      const u = item.url;
      if (!u.startsWith(prefix)) return false;
      if (u === prefix) return false;
      const rest = u.slice(prefix.length);
      // Expect exactly "slug/" — no further slashes inside
      return /^[^/]+\/$/.test(rest);
    });
  });

  // Filter: siblings of a URL (same parent, exclude self)
  eleventyConfig.addFilter("siblingsOf", function (items, url) {
    if (!Array.isArray(items) || !url || url === "/") return [];
    const parts = url.split("/").filter(Boolean);
    if (parts.length === 0) return [];
    const parent = "/" + parts.slice(0, -1).join("/") + (parts.length > 1 ? "/" : "");
    const parentPrefix = parent === "/" ? "/" : parent;
    return items.filter((item) => {
      if (!item || !item.url) return false;
      if (item.url === url) return false;
      const u = item.url;
      if (!u.startsWith(parentPrefix)) return false;
      const rest = u.slice(parentPrefix.length);
      return /^[^/]+\/$/.test(rest);
    });
  });

  // Build breadcrumb chain from a URL like /a/b/c/, resolving titles from the all-collection.
  eleventyConfig.addFilter("breadcrumbs", function (url, all) {
    if (!url || url === "/") return [{ title: "Home", url: "/" }];
    const parts = url.split("/").filter(Boolean);
    const crumbs = [{ title: "Home", url: "/" }];
    let acc = "";
    const byUrl = new Map();
    if (Array.isArray(all)) {
      for (const item of all) {
        if (item && item.url) byUrl.set(item.url, item);
      }
    }
    for (let i = 0; i < parts.length; i++) {
      acc += "/" + parts[i];
      const u = acc + "/";
      const hit = byUrl.get(u);
      const fallback = parts[i].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      crumbs.push({
        title: (hit && hit.data && hit.data.title) ? hit.data.title : fallback,
        url: u,
      });
    }
    return crumbs;
  });

  return {
    dir: {
      input: "src",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    // Don't preprocess markdown with Nunjucks — content blocks may contain
    // literal `{{` / `{%` that conflicts with the template syntax.
    markdownTemplateEngine: false,
    htmlTemplateEngine: "njk",
    templateFormats: ["njk", "md", "html", "11ty.js"],
  };
};
