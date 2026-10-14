// Checks a per-domain README against spec/repository.md §8: a "# <domain>" heading and one
// `| tool | description |` table with one row per registry tool, sorted by tool name.
// Nothing else is allowed besides blank lines.

const splitRow = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
const isTableLine = (line) => line.trim().startsWith("|");
const isSeparator = (cells) => cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
const unquote = (cell) => cell.replace(/^`(.*)`$/, "$1");

export function checkDomainReadme(domain, toolNames, text) {
  const problems = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const content = lines.map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => line.trim() !== "");

  if (content.length === 0) return ["is empty"];
  const [heading, ...rest] = content;
  if (heading.line.trim() !== `# ${domain}`) problems.push(`line ${heading.n}: first line must be "# ${domain}"`);

  // The table is the first run of consecutive table lines; anything else is extra content.
  const start = rest.findIndex(({ line }) => isTableLine(line));
  if (start === -1) {
    for (const { n } of rest) problems.push(`line ${n}: content other than the heading and the table is not allowed`);
    return [...problems, `missing the "| tool | description |" table`];
  }
  let end = start;
  while (end < rest.length && isTableLine(rest[end].line) && (end === start || rest[end].n === rest[end - 1].n + 1)) end++;
  for (const { line, n } of [...rest.slice(0, start), ...rest.slice(end)]) {
    problems.push(isTableLine(line) ? `line ${n}: only one table is allowed` : `line ${n}: content other than the heading and the table is not allowed`);
  }

  const table = rest.slice(start, end);
  const header = splitRow(table[0].line);
  if (header.length !== 2 || header[0] !== "tool" || header[1] !== "description") {
    problems.push(`line ${table[0].n}: table header must be "| tool | description |"`);
  }
  if (table.length < 2 || !isSeparator(splitRow(table[1].line)) || splitRow(table[1].line).length !== 2) {
    problems.push(`line ${table[0].n + 1}: table header must be followed by a two-column separator row`);
  }

  const names = [];
  for (const { line, n } of table.slice(2)) {
    const cells = splitRow(line);
    if (cells.length !== 2) { problems.push(`line ${n}: row must have exactly two cells`); continue; }
    const name = unquote(cells[0]);
    if (!cells[1]) problems.push(`line ${n}: ${name} has an empty description`);
    names.push({ name, n });
  }

  const expected = new Set(toolNames);
  const seen = new Set();
  for (const { name, n } of names) {
    if (seen.has(name)) problems.push(`line ${n}: duplicate row for ${name}`);
    else if (!expected.has(name)) problems.push(`line ${n}: ${name} is not a registry tool for ${domain}`);
    seen.add(name);
  }
  for (const name of [...expected].sort()) if (!seen.has(name)) problems.push(`table has no row for ${name}`);
  const order = names.map(({ name }) => name);
  if (order.join("\n") !== [...order].sort().join("\n")) problems.push("table rows must be sorted by tool name");
  return problems;
}
