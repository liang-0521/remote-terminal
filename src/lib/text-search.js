const WORD_CHARACTER = "\\p{L}\\p{N}_";

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findTextMatches(content, query, options = {}) {
  if (!query) return { matches: [], error: "" };
  const caseSensitive = Boolean(options.caseSensitive);
  const regularExpression = Boolean(options.regularExpression);
  const wholeWord = Boolean(options.wholeWord);
  let source = regularExpression ? query : escapeRegularExpression(query);
  if (wholeWord) source = `(?<![${WORD_CHARACTER}])(?:${source})(?![${WORD_CHARACTER}])`;

  let pattern;
  try {
    pattern = new RegExp(source, `gu${caseSensitive ? "" : "i"}`);
  } catch {
    return { matches: [], error: "正则表达式无效" };
  }

  const matches = [];
  for (const match of content.matchAll(pattern)) {
    const value = match[0];
    if (!value.length) continue;
    matches.push({ index: match.index, length: value.length });
  }
  return { matches, error: "" };
}
