import test from "node:test";
import assert from "node:assert/strict";
import { parseLangBlocks } from "../src/markdownProcessor";

const cases = [
  {
    name: "fenced",
    input: ":::lang zh-CN\nhello\n:::",
  },
  {
    name: "hexo",
    input: "{% i8n zh-CN %}\nhello\n{% endlang %}",
  },
  {
    name: "comment",
    input: "[//]: # (lang zh-CN)\nhello\n[//]: # (endlang)",
  },
  {
    name: "obsidian-comment",
    input: "%% lang zh-CN %%\nhello\n%% endlang %%",
  },
];

for (const syntaxCase of cases) {
  test(`${syntaxCase.name} syntax has one paired block`, () => {
    const blocks = parseLangBlocks(syntaxCase.input);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].langCode, "zh-CN");
    assert.equal(blocks[0].openLine, 0);
    assert.equal(blocks[0].closeLine, 2);
  });
}
