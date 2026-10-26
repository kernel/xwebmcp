const SKIP = new Set(["script", "style", "svg", "img"]);
const PARAGRAPH = new Set(["p", "ul", "ol", "pre", "blockquote", "table", "h1", "h2", "h3", "h4", "h5", "h6", "hr"]);
const LINE = new Set(["div", "li", "tr"]);
const text = node => {
  if (node.nodeType === 3) return node.data;
  if (node.nodeType !== 1 || SKIP.has(node.localName)) return "";
  const inner = Array.from(node.childNodes, child => text(child)).join("");
  if (node.localName === "td" || node.localName === "th") return inner + " ";
  if (node.localName === "input" && node.getAttribute("type") === "checkbox") return node.hasAttribute("checked") ? "[x] " : "[ ] ";
  if (node.localName === "br") return "\n";
  if (PARAGRAPH.has(node.localName)) return "\n\n" + inner + "\n\n";
  return LINE.has(node.localName) ? inner + "\n" : inner;
};
const rendered = node => text(node).replace(/[ \t\u00a0]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
