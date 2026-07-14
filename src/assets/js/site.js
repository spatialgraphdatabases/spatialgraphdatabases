/* Site enhancements: SW registration, copy buttons, mermaid, KaTeX, checkbox toggling. */
(function () {
  "use strict";

  // ---------- Service worker ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => { /* ignore */ });
    });
  }

  // ---------- Copy buttons on code blocks ----------
  function attachCopyButtons() {
    const blocks = document.querySelectorAll("pre > code");
    blocks.forEach((code) => {
      const pre = code.parentElement;
      if (!pre || pre.querySelector(".copy-btn")) return;
      if (pre.classList.contains("mermaid")) return;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn";
      btn.setAttribute("aria-label", "Copy code to clipboard");
      btn.textContent = "Copy";

      btn.addEventListener("click", async () => {
        const text = code.innerText;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand("copy"); } catch (_) {}
          document.body.removeChild(ta);
        }
        btn.dataset.state = "copied";
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.dataset.state = "";
          btn.textContent = "Copy";
        }, 1600);
      });

      pre.appendChild(btn);
    });
  }

  // ---------- Mermaid (lazy-load only when needed) ----------
  function initMermaid() {
    const nodes = document.querySelectorAll("pre.mermaid");
    if (!nodes.length) return;
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js";
    s.onload = () => {
      try {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          themeVariables: {
            primaryColor: "#0e7c86",
            primaryTextColor: "#1b2330",
            primaryBorderColor: "#0e7c86",
            lineColor: "#5b21b6",
            secondaryColor: "#f9c66b",
            tertiaryColor: "#fbfaf6",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          },
        });
        window.mermaid.run({ querySelector: "pre.mermaid" });
      } catch (_) {}
    };
    document.head.appendChild(s);
  }

  // ---------- KaTeX (only if math markers present) ----------
  function initKatex() {
    const text = document.querySelector("main")?.textContent || "";
    if (!/(\$\$[\s\S]+?\$\$|\$[^$\n]+\$)/.test(text)) return;
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
    document.head.appendChild(css);
    const s1 = document.createElement("script");
    s1.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";
    s1.onload = () => {
      const s2 = document.createElement("script");
      s2.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js";
      s2.onload = () => {
        try {
          window.renderMathInElement(document.querySelector("main"), {
            delimiters: [
              { left: "$$", right: "$$", display: true },
              { left: "$", right: "$", display: false },
            ],
            throwOnError: false,
          });
        } catch (_) {}
      };
      document.head.appendChild(s2);
    };
    document.head.appendChild(s1);
  }

  // ---------- Task-list checkboxes: interactive + persisted ----------
  function initTaskCheckboxes() {
    const key = `taskboxes::${location.pathname}`;
    let store = {};
    try { store = JSON.parse(localStorage.getItem(key) || "{}"); } catch (_) {}

    const boxes = document.querySelectorAll('.page__content li > input[type="checkbox"]');
    boxes.forEach((cb, i) => {
      cb.removeAttribute("disabled");
      const id = `tb-${i}`;
      cb.dataset.tb = id;
      if (store[id] === true) cb.checked = true;
      if (store[id] === false) cb.checked = false;
      cb.addEventListener("change", () => {
        store[cb.dataset.tb] = cb.checked;
        try { localStorage.setItem(key, JSON.stringify(store)); } catch (_) {}
      });
    });
  }

  // ---------- Table of contents + scroll spy ----------
  function initToc() {
    const tocEl = document.querySelector("[data-toc]");
    const navEl = document.querySelector("[data-toc-nav]");
    const content = document.querySelector(".page__content");
    if (!tocEl || !navEl || !content) return;

    const headings = Array.from(content.querySelectorAll("h2[id], h3[id]"));
    // Only show TOC when we have at least 3 H2-or-H3s — short pages don't need it
    const h2count = headings.filter((h) => h.tagName === "H2").length;
    if (h2count < 3) return;

    const ol = document.createElement("ol");
    headings.forEach((h) => {
      if (h.tagName === "H3" && !h.closest("section, article")) return;
      const li = document.createElement("li");
      li.className = h.tagName === "H3" ? "is-h3" : "is-h2";
      const a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = h.textContent.replace(/¶|#/g, "").trim();
      a.dataset.target = h.id;
      li.appendChild(a);
      ol.appendChild(li);
    });
    navEl.appendChild(ol);
    tocEl.hidden = false;

    const linkById = new Map(
      Array.from(navEl.querySelectorAll("a[data-target]")).map((a) => [a.dataset.target, a])
    );

    let activeId = null;
    const setActive = (id) => {
      if (id === activeId) return;
      if (activeId && linkById.has(activeId)) linkById.get(activeId).classList.remove("is-active");
      activeId = id;
      if (id && linkById.has(id)) linkById.get(id).classList.add("is-active");
    };

    if ("IntersectionObserver" in window) {
      const visible = new Map();
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) visible.set(e.target.id, e.intersectionRatio);
            else visible.delete(e.target.id);
          }
          // Pick the heading nearest the top of the viewport
          let best = null, bestTop = Infinity;
          for (const id of visible.keys()) {
            const el = document.getElementById(id);
            if (!el) continue;
            const top = el.getBoundingClientRect().top;
            if (top >= 0 && top < bestTop) { bestTop = top; best = id; }
          }
          if (!best && headings.length) {
            // Fallback: last heading whose top is above viewport
            for (let i = headings.length - 1; i >= 0; i--) {
              if (headings[i].getBoundingClientRect().top < 100) { best = headings[i].id; break; }
            }
          }
          setActive(best);
        },
        { rootMargin: "-80px 0px -70% 0px", threshold: [0, 1] }
      );
      headings.forEach((h) => io.observe(h));
    }
  }

  // ---------- Reading time estimate ----------
  function initReadingTime() {
    const target = document.querySelector("[data-reading-time]");
    const content = document.querySelector(".page__content");
    if (!target || !content) return;
    const text = content.innerText || "";
    const words = (text.match(/\S+/g) || []).length;
    if (words < 80) return;
    const minutes = Math.max(1, Math.round(words / 220));
    target.textContent = `${minutes} min read · ${words.toLocaleString()} words`;
  }

  function init() {
    attachCopyButtons();
    initMermaid();
    initKatex();
    initTaskCheckboxes();
    initToc();
    initReadingTime();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
