"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

// Canonical inventory: the CLI onboarding list every other public surface must
// stay in parity with. The expected count is derived from it once — do not
// scatter literal counts through the assertions below.
const SUPPORTED_PROVIDERS = (() => {
  const source = read("src/commands/init.js");
  const block = source.match(/const SUPPORTED_PROVIDERS = \[([\s\S]*?)\];/);
  assert.ok(block, "init defines SUPPORTED_PROVIDERS");
  return [...block[1].matchAll(/^\s*"([^"]+)",?$/gm)].map((match) => match[1]);
})();
const TOOL_COUNT = SUPPORTED_PROVIDERS.length;

test("public discovery surfaces describe every supported tool", () => {
  // Devin CLI is the 38th integration — a token-statistics source, not a
  // quota-only badge — so every public inventory must carry it explicitly.
  assert.ok(SUPPORTED_PROVIDERS.includes("Devin CLI"), "init advertises Devin CLI");

  const readme = read("README.md");
  assert.match(readme, new RegExp(`${TOOL_COUNT} AI coding tools`), "README.md has the current provider count");
  assert.match(readme, new RegExp(`\\|\\s+\\*\\*AI tools supported\\*\\*\\s+\\|\\s+\\*\\*${TOOL_COUNT}\\*\\*`));
  assert.match(readme, /Rate-limit tracking.*✅ 18 providers/);
  assert.doesNotMatch(readme, /\bAcode\b/);
  for (const tool of ["Droid", "AnythingLLM Desktop", "Qoder", "DeepSeek Harness", "Prime Agent", "TRAE Work CN",
    "AStudio", "LM Studio", "Unsloth Studio", "Devin CLI", "Cline", "MiniMax Code", "Command Code", "DuMate"]) {
    assert.ok(readme.includes(tool), `README.md lists ${tool}`);
  }
  for (const option of ["TOKENTRACKER_ACODE_HOME", "TOKENTRACKER_DUMATE_HOME", "TOKENTRACKER_LMSTUDIO_HOME",
    "TOKENTRACKER_UNSLOTH_DB", "TOKENTRACKER_DEVIN_DB"]) {
    assert.ok(readme.includes(option), `README.md documents ${option}`);
  }

  const index = read("dashboard/index.html");
  assert.doesNotMatch(index, /13 AI coding/);
  assert.match(index, new RegExp(`Supported AI coding tools \\(${TOOL_COUNT}\\)`));
  assert.match(index, /TRAE Work CN/);
  assert.match(index, /AStudio/);
  assert.doesNotMatch(index, /\bAcode\b/);
  assert.match(index, /Devin CLI/);
  assert.match(index, /Cline/);
  assert.match(index, /DuMate/);
  assert.match(index, /Desktop pet/);
  assert.match(index, /Four desktop widgets/);
  assert.match(index, /Achievements/);
  assert.match(index, /Service Status page/);
  assert.match(index, /__TOKENTRACKER_DISCOVERY_TRACKED_USAGE__/);
  assert.match(read("dashboard/src/content/copy.csv"), /landing\.discovery\.tracked_usage,.*usage limits for 18 providers/i);

  const llms = read("dashboard/public/llms.txt");
  assert.match(llms, new RegExp(`Supported AI coding tools \\(${TOOL_COUNT}\\)`));
  assert.match(llms, /TRAE Work CN/);
  assert.match(llms, /AStudio/);
  assert.doesNotMatch(llms, /\bAcode\b/);
  assert.match(llms, /Devin CLI/);
  assert.match(llms, /Cline/);
  assert.match(llms, /DuMate/);
  assert.match(llms, /desktop pet/i);
  assert.match(llms, /four desktop widgets/i);
  assert.match(llms, /achievements/i);
});

test("marketing logo wall includes the same supported product integrations", () => {
  const source = read("dashboard/src/ui/marketing/agent-logos.js");
  const providers = [...source.matchAll(/provider:\s*"([^"]+)"/g)].map((match) => match[1]);
  const ids = [...source.matchAll(/\bid:\s*(\d+)/g)].map((match) => Number(match[1]));
  assert.equal(providers.length, TOOL_COUNT);
  assert.equal(new Set(providers).size, TOOL_COUNT);
  assert.equal(ids.length, TOOL_COUNT);
  assert.equal(new Set(ids).size, TOOL_COUNT, "merged integrations keep unique carousel IDs");

  for (const provider of ["every-code", "acode", "reasonix", "kilocode", "roocode", "zed", "goose", "droid", "qoder", "anythingllm", "dsh", "prime-agent", "trae-cn", "dots", "lmstudio", "unsloth", "devin", "cline", "minimax-code", "command-code", "dumate", "muse"]) {
    assert.ok(providers.includes(provider), `logo wall includes ${provider}`);
  }
});

test("CLI onboarding advertises the same supported integrations", () => {
  assert.equal(new Set(SUPPORTED_PROVIDERS).size, TOOL_COUNT);
  for (const provider of SUPPORTED_PROVIDERS) {
    assert.ok(provider && !/^\s|\s$/.test(provider), `provider name is trimmed: ${provider}`);
  }
  assert.ok(SUPPORTED_PROVIDERS.includes("Droid"));
  assert.ok(SUPPORTED_PROVIDERS.includes("AnythingLLM Desktop"));
  assert.ok(SUPPORTED_PROVIDERS.includes("Qoder"));
  assert.ok(SUPPORTED_PROVIDERS.includes("Reasonix"));
  assert.ok(SUPPORTED_PROVIDERS.includes("Muse Code"));
  assert.ok(SUPPORTED_PROVIDERS.includes("DeepSeek Harness"));
  assert.ok(SUPPORTED_PROVIDERS.includes("Prime Agent"));
  assert.ok(SUPPORTED_PROVIDERS.includes("TRAE Work CN"));
  assert.ok(SUPPORTED_PROVIDERS.includes("Dots"));
  assert.ok(SUPPORTED_PROVIDERS.includes("AStudio"));
  assert.ok(SUPPORTED_PROVIDERS.includes("LM Studio"));
  assert.ok(SUPPORTED_PROVIDERS.includes("Unsloth Studio"));
  assert.ok(SUPPORTED_PROVIDERS.includes("Devin CLI"));
  assert.ok(SUPPORTED_PROVIDERS.includes("Cline"));
  assert.ok(SUPPORTED_PROVIDERS.includes("MiniMax Code"));
  assert.ok(SUPPORTED_PROVIDERS.includes("Command Code"));
  assert.ok(SUPPORTED_PROVIDERS.includes("DuMate"));
});

test("npm metadata carries the current product hook", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.description, new RegExp(`${TOOL_COUNT} tools`));
  assert.match(pkg.description, /desktop pet/);
  assert.ok(pkg.keywords.includes("desktop-widget"));
  assert.ok(pkg.keywords.includes("ai-coding-tools"));
});

test("dashboard JSON-LD scripts parse as valid JSON", () => {
  const index = read("dashboard/index.html");
  const blocks = [...index.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]);
  assert.ok(blocks.length > 0, "dashboard/index.html includes JSON-LD");

  const parsed = blocks.map((block, i) => {
    try {
      return JSON.parse(block);
    } catch (err) {
      assert.fail(`JSON-LD block ${i} failed to parse: ${err.message}`);
    }
  });

  const graph = parsed.flatMap((doc) => (Array.isArray(doc["@graph"]) ? doc["@graph"] : [doc]));

  const faq = graph.find((node) => node["@type"] === "FAQPage");
  assert.ok(faq, "JSON-LD includes an FAQPage");
  const supportedClis = (faq.mainEntity || []).find((entity) =>
    entity.name === "Which AI coding CLIs does Token Tracker support?",
  );
  assert.ok(supportedClis, "FAQ includes the supported-CLIs question");
  assert.equal(supportedClis["@type"], "Question");

  const tools = graph.find((node) => node["@type"] === "ItemList" && node.name === "Supported AI coding agent CLIs");
  assert.ok(tools, "JSON-LD includes the coding-tools ItemList");
  assert.ok(Array.isArray(tools.itemListElement), "coding-tools ItemList is an array");
  assert.equal(tools.itemListElement.length, TOOL_COUNT);
  assert.equal(new Set(tools.itemListElement.map((item) => item.name)).size, TOOL_COUNT);
  assert.ok(tools.itemListElement.some((item) => item.name === "AStudio"));
  assert.ok(tools.itemListElement.some((item) => item.name === "LM Studio"));
  assert.ok(tools.itemListElement.some((item) => item.name === "Unsloth Studio"));
  assert.ok(tools.itemListElement.some((item) => item.name === "Devin CLI"));
  assert.ok(tools.itemListElement.some((item) => item.name === "Cline"));
  assert.ok(tools.itemListElement.some((item) => item.name === "MiniMax Code"));
  assert.ok(tools.itemListElement.some((item) => item.name === "Command Code"));
  assert.ok(tools.itemListElement.some((item) => item.name === "DuMate"));
  assert.match(supportedClis.acceptedAnswer.text, new RegExp(`${TOOL_COUNT} AI coding tools`));
  assert.match(supportedClis.acceptedAnswer.text, /AStudio/);
  assert.match(supportedClis.acceptedAnswer.text, /Devin CLI/);
  assert.match(supportedClis.acceptedAnswer.text, /Command Code/);
});
