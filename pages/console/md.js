/**
 * 轻量 Markdown → 安全 HTML（无外链依赖）。
 * 覆盖 docs/*.md 实际用到的：标题 / 段落 / 列表 / 表格 / 代码块 / 引用 /
 * 图片 / 链接 / details-summary / 粗斜体 / 行内 code / hr。
 */
import { esc, attr } from "./utils.js?v=3.0.0";

function inline(src) {
  let s = esc(src ?? "");
  // 图片（已转 data URI 或外链）
  s = s.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+[\"'][^\"']*[\"'])?\)/g,
    (_, alt, url) => {
      const u = String(url || "");
      if (!(u.startsWith("data:") || /^https?:\/\//i.test(u))) {
        return esc(`![${alt}](${url})`);
      }
      return `<img class="md-img" src="${attr(u)}" alt="${attr(alt)}" loading="lazy" />`;
    },
  );
  // 链接 [text](url) —— #doc:id 留给外层绑定
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const u = String(url || "");
    if (u.startsWith("#doc:")) {
      return `<a class="md-doc-link" href="${attr(u)}" data-doc="${attr(u.slice(5).split("#")[0])}">${text}</a>`;
    }
    if (u.startsWith("#")) {
      return `<a class="md-anchor" href="${attr(u)}">${text}</a>`;
    }
    if (/^https?:\/\//i.test(u)) {
      return `<a class="md-ext" href="${attr(u)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    return text;
  });
  // 粗体 / 斜体（先粗后斜）
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(?<!_)_([^_]+)_(?!_)/g, "<em>$1</em>");
  // 行内 code（转义已做，反引号内不再二次处理）
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  return s;
}

function flushParagraph(buf, out) {
  const text = buf.join("\n").trim();
  if (!text) return;
  out.push(`<p class="md-p">${inline(text.replace(/\n/g, " "))}</p>`);
  buf.length = 0;
}

function parseTable(lines, start) {
  // 至少 header + separator
  if (start + 1 >= lines.length) return null;
  const header = lines[start];
  const sep = lines[start + 1];
  if (!/^\s*\|?.+\|.+\|?\s*$/.test(header)) return null;
  if (!/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(sep)) return null;

  const splitRow = (row) => {
    let r = row.trim();
    if (r.startsWith("|")) r = r.slice(1);
    if (r.endsWith("|")) r = r.slice(0, -1);
    return r.split("|").map((c) => c.trim());
  };

  const heads = splitRow(header);
  const rows = [];
  let i = start + 2;
  while (i < lines.length && /^\s*\|?.+\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  const thead = `<thead><tr>${heads.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows
    .map((r) => {
      const cells = heads.map((_, idx) => `<td>${inline(r[idx] ?? "")}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("")}</tbody>`;
  return {
    html: `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`,
    next: i,
  };
}

/**
 * @param {string} md
 * @returns {string} HTML
 */
export function renderMarkdown(md) {
  const src = String(md ?? "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const out = [];
  const para = [];
  let i = 0;
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listType = null; // "ul" | "ol"
  let listItems = [];

  const closeList = () => {
    if (!listType) return;
    const tag = listType;
    const items = listItems.map((t) => `<li>${inline(t)}</li>`).join("");
    out.push(`<${tag} class="md-list md-${tag}">${items}</${tag}>`);
    listType = null;
    listItems = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph(para, out);
      closeList();
      if (!inCode) {
        inCode = true;
        codeLang = fence[1] || "";
        codeBuf = [];
      } else {
        const code = esc(codeBuf.join("\n"));
        const langCls = codeLang ? ` language-${attr(codeLang)}` : "";
        out.push(`<pre class="md-pre"><code class="md-code-block${langCls}">${code}</code></pre>`);
        inCode = false;
        codeLang = "";
        codeBuf = [];
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    // HTML details block（原样保留，内部 markdown 递归一次）
    if (/^\s*<details\b/i.test(line)) {
      flushParagraph(para, out);
      closeList();
      const block = [line];
      if (!/<\/details>/i.test(line)) {
        i++;
        while (i < lines.length && !/<\/details>/i.test(lines[i])) {
          block.push(lines[i]);
          i++;
        }
        if (i < lines.length) block.push(lines[i]);
      }
      const raw = block.join("\n");
      // 提取 summary + 内部 md
      const sm = raw.match(/<summary>([\s\S]*?)<\/summary>/i);
      const summary = sm ? sm[1].trim() : "详情";
      let inner = raw
        .replace(/<details[^>]*>/i, "")
        .replace(/<\/details>/i, "")
        .replace(/<summary>[\s\S]*?<\/summary>/i, "")
        .trim();
      out.push(
        `<details class="md-details"><summary>${esc(summary)}</summary><div class="md-details-body">${renderMarkdown(inner)}</div></details>`,
      );
      i++;
      continue;
    }

    // raw HTML img / p align center 整行（docs 用 p align center 包 img）
    if (/^\s*<p\b/i.test(line) || /^\s*<img\b/i.test(line)) {
      flushParagraph(para, out);
      closeList();
      const block = [line];
      if (!/<\/p>/i.test(line) && /^\s*<p\b/i.test(line)) {
        i++;
        while (i < lines.length && !/<\/p>/i.test(lines[i])) {
          block.push(lines[i]);
          i++;
        }
        if (i < lines.length) block.push(lines[i]);
      }
      let html = block.join("\n");
      // 只放行 img / p / 对齐属性；src 已是 data: 或 http
      html = html.replace(
        /<img\b([^>]*)>/gi,
        (_, attrs) => {
          const srcM = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
          const altM = attrs.match(/\balt\s*=\s*["']([^"']*)["']/i);
          const wM = attrs.match(/\bwidth\s*=\s*["']?([\d.]+%?)["']?/i);
          const src = srcM?.[1] || "";
          if (!(src.startsWith("data:") || /^https?:\/\//i.test(src))) {
            return "";
          }
          const style = wM ? ` style="max-width:${attr(wM[1])};width:100%;height:auto"` : "";
          return `<img class="md-img" src="${attr(src)}" alt="${attr(altM?.[1] || "")}" loading="lazy"${style} />`;
        },
      );
      if (/align\s*=\s*["']center["']/i.test(html) || /text-align:\s*center/i.test(html)) {
        out.push(`<div class="md-center">${html.replace(/<\/?p\b[^>]*>/gi, "")}</div>`);
      } else {
        out.push(html.replace(/<\/?p\b[^>]*>/gi, ""));
      }
      i++;
      continue;
    }

    // blank
    if (!line.trim()) {
      flushParagraph(para, out);
      closeList();
      i++;
      continue;
    }

    // hr
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(para, out);
      closeList();
      out.push('<hr class="md-hr" />');
      i++;
      continue;
    }

    // headings
    const hm = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (hm) {
      flushParagraph(para, out);
      closeList();
      const level = hm[1].length;
      out.push(`<h${level} class="md-h md-h${level}">${inline(hm[2])}</h${level}>`);
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(para, out);
      closeList();
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote class="md-quote">${renderMarkdown(q.join("\n"))}</blockquote>`);
      continue;
    }

    // table
    const table = parseTable(lines, i);
    if (table) {
      flushParagraph(para, out);
      closeList();
      out.push(table.html);
      i = table.next;
      continue;
    }

    // lists
    const ulm = line.match(/^\s*[-*+]\s+(.+)$/);
    const olm = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ulm || olm) {
      flushParagraph(para, out);
      const t = ulm ? "ul" : "ol";
      if (listType && listType !== t) closeList();
      listType = t;
      listItems.push((ulm || olm)[1]);
      i++;
      continue;
    }

    // default paragraph line
    closeList();
    para.push(line);
    i++;
  }

  if (inCode) {
    // 未闭合 code fence：当作 pre
    out.push(`<pre class="md-pre"><code class="md-code-block">${esc(codeBuf.join("\n"))}</code></pre>`);
  }
  flushParagraph(para, out);
  closeList();
  return out.join("\n");
}
