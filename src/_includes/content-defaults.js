// Shared default front-matter for every markdown content page.
module.exports = {
  layout: "layouts/page.njk",
  tags: ["content"],
  eleventyComputed: {
    title: (data) => {
      const m = (data.page.rawInput || "").match(/^#\s+(.+)$/m);
      return m ? m[1].trim() : data.title || "";
    },
    description: (data) => {
      const text = (data.page.rawInput || "").replace(/^#.*$/m, "").trim();
      const first = text.split(/\n\n+/)[0] || "";
      const cleaned = first
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[`*_]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      // Search results usually show about 155-160 characters; aim for 160 or fewer and
      // truncate on a word boundary with an ellipsis if we have to cut.
      const MAX = 160;
      if (cleaned.length <= MAX) return cleaned;
      const slice = cleaned.slice(0, MAX);
      const cut = slice.lastIndexOf(" ");
      return (cut > 100 ? slice.slice(0, cut) : slice).replace(/[,;:.\s]+$/, "") + "…";
    },
    hasMath: (data) => /(\$\$[\s\S]+?\$\$|\$[^$\n]+\$)/.test(data.page.rawInput || ""),
  },
};
