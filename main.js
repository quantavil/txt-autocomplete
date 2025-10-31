const {
  App,
  Editor,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
  EditorSuggest,
  normalizePath,
} = require('obsidian');

// ============================================================================
// Optimized Trie (alphabetical traversal)
// ============================================================================

class TrieNode {
  constructor() {
    this.children = new Map();
    this.isWord = false;
  }
}

class Trie {
  constructor() {
    this.root = new TrieNode();
  }

  insert(word) {
    if (!word) return;
    let node = this.root;
    for (const ch of word.toLowerCase()) {
      if (!node.children.has(ch)) node.children.set(ch, new TrieNode());
      node = node.children.get(ch);
    }
    node.isWord = true;
  }

  search(prefix, limit) {
    if (!prefix) return [];
    let node = this.root;
    prefix = prefix.toLowerCase();
    for (const ch of prefix) {
      node = node.children.get(ch);
      if (!node) return [];
    }
    const out = [];
    this._collect(node, prefix, out, limit);
    return out;
  }
  searchFuzzy(term, maxEdits, limit) {
    if (!term) return [];
    const query = term.toLowerCase().normalize('NFC');
    const cols = query.length + 1;

    const firstRow = new Array(cols);
    for (let j = 0; j < cols; j++) firstRow[j] = j;

    const out = []; // { word, dist }
    this._fuzzyDfs(this.root, '', '', query, firstRow, null, maxEdits, out, limit);

    out.sort((a, b) => a.dist - b.dist || a.word.localeCompare(b.word, undefined, { sensitivity: 'base' }));
    return out.slice(0, limit).map(x => x.word);
  }

  // Damerau–Levenshtein (OSA) over the trie with pruning by row minimum
  _fuzzyDfs(node, prefix, prevChar, query, prevRow, prevPrevRow, maxEdits, out, limit) {
    for (const [ch, child] of node.children) {
      const currRow = [prevRow[0] + 1];
      let rowMin = currRow[0];

      for (let j = 1; j < prevRow.length; j++) {
        const cost = query[j - 1] === ch ? 0 : 1;
        let v = Math.min(
          currRow[j - 1] + 1,     // insertion
          prevRow[j] + 1,         // deletion
          prevRow[j - 1] + cost   // substitution
        );

        // Adjacent transposition (OSA)
        if (prevPrevRow && j > 1 && ch === query[j - 2] && prevChar === query[j - 1]) {
          v = Math.min(v, prevPrevRow[j - 2] + 1);
        }

        currRow[j] = v;
        if (v < rowMin) rowMin = v;
      }

      const newPrefix = prefix + ch;
      const dist = currRow[currRow.length - 1];

      if (child.isWord && dist <= maxEdits) {
        out.push({ word: newPrefix, dist });
        // keep candidate list contained as we traverse
        if (out.length > limit * 8) {
          out.sort((a, b) => a.dist - b.dist || a.word.localeCompare(b.word));
          out.length = limit * 4;
        }
      }

      // prune this branch if we cannot keep distance within maxEdits
      if (rowMin <= maxEdits) {
        this._fuzzyDfs(child, newPrefix, ch, query, currRow, prevRow, maxEdits, out, limit);
      }
    }
  }
  _collect(node, prefix, out, limit) {
    if (out.length >= limit) return;
    if (node.isWord) out.push(prefix);
    const keys = Array.from(node.children.keys()).sort();
    for (const k of keys) {
      if (out.length >= limit) break;
      this._collect(node.children.get(k), prefix + k, out, limit);
    }
  }
}

// ============================================================================
// Settings
// ============================================================================

const DEFAULT_SETTINGS = {
  enabled: true,
  maxSuggestions: 5,    // 3–10 recommended
  minLength: 3,         // 2–5 recommended
  addSpace: true,
  enableInCode: false,
};

// ============================================================================
// EditorSuggest implementation
// ============================================================================

class WordSuggest extends EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor, file) {
    if (!this.plugin.settings.enabled) return null;

    const lineText = editor.getLine(cursor.line);
    const before = lineText.slice(0, cursor.ch);
    const after = lineText.slice(cursor.ch);

    // Don’t trigger mid‑word
    if (/^[\p{L}\p{N}]/u.test(after)) return null;

    // Skip code contexts if disabled
    if (!this.plugin.settings.enableInCode && this.plugin.isInCode(editor, cursor)) return null;

    // Unicode word: letters/digits plus apostrophe
    const m = before.match(/\p{L}[\p{L}\p{N}']*$/u);
    if (!m) return null;

    const word = m[0];
    if (word.length < this.plugin.settings.minLength) return null;

    const start = { line: cursor.line, ch: cursor.ch - word.length };
    return { start, end: cursor, query: word };
  }

  getSuggestions(ctx) {
    return this.plugin.getSuggestions(ctx.query);
  }

  renderSuggestion(s, el) {
    const q = this.context.query;
    const pre = el.createSpan({ cls: 'autocomplete-match' });
    pre.textContent = s.substring(0, q.length);
    el.appendChild(document.createTextNode(s.substring(q.length)));
  }

  selectSuggestion(s) {
    const editor = this.plugin.getEditor();
    const ctx = this.context;
    if (!editor || !ctx) return;

    const insert =
      this.plugin.matchCase(s, ctx.query) + (this.plugin.settings.addSpace ? ' ' : '');
    editor.replaceRange(insert, ctx.start, ctx.end);
    this.close();
  }
}

// ============================================================================
// Main plugin (JS)
// ============================================================================

class TextAutocompletePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.trie = new Trie();
    await this.loadDictionary();

    this.suggest = new WordSuggest(this);
    this.registerEditorSuggest(this.suggest);

    this.addSettingTab(new AutocompleteSettingTab(this.app, this));
    console.log('Text Autocomplete loaded');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async loadDictionary() {
    try {
      const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
      const path = normalizePath(`${pluginDir}/words.txt`);
      const content = await this.app.vault.adapter.read(path);
      for (const raw of content.split('\n')) {
        const w = raw.trim();
        if (w) this.trie.insert(w);
      }
      console.log('Dictionary loaded');
    } catch (e) {
      console.error('Failed to load words.txt:', e);
    }
  }

  // Inside class TextAutocompletePlugin
  getSuggestions(prefix) {
    const limit = this.settings.maxSuggestions;
    const exact = this.trie.search(prefix, limit);

    if (exact.length >= limit) {
      return exact.map(w => this.matchCase(w, prefix));
    }

    // Compute allowed edits based on query length (fast + generous on long words)
    const edits = this.allowedEdits(prefix);

    // Pull more than needed; we’ll dedupe + trim
    const fuzzy = this.trie.searchFuzzy(prefix, edits, limit * 6);

    // Merge with exact, preferring exact first
    const seen = new Set(exact.map(w => w.toLowerCase().normalize('NFC')));
    const merged = [...exact];
    for (const w of fuzzy) {
      const k = w.toLowerCase().normalize('NFC');
      if (!seen.has(k)) {
        merged.push(w);
        seen.add(k);
        if (merged.length >= limit) break;
      }
    }

    return merged.slice(0, limit).map(w => this.matchCase(w, prefix));
  }

  allowedEdits(q) {
    const n = (q || '').toLowerCase().normalize('NFC').length;
    if (n <= 4) return 1;
    if (n <= 8) return 2;
    return 3;
  }
  matchCase(word, original) {
    if (original === original.toUpperCase()) return word.toUpperCase();
    if (original[0] === original[0].toUpperCase()) {
      return word[0].toUpperCase() + word.slice(1).toLowerCase();
    }
    return word.toLowerCase();
  }

  // Efficient code-context detection: walk backwards for fences; check inline backticks
  isInCode(editor, cursor) {
    const fence = /^```/;
    let inBlock = false;
    for (let i = cursor.line; i >= 0; i--) {
      const line = editor.getLine(i);
      if (fence.test(line)) inBlock = !inBlock;
    }
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const inlineTicks = (before.match(/`/g) || []).length % 2 === 1;
    return inBlock || inlineTicks;
  }

  getEditor() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.editor ?? null;
  }
}

// ============================================================================
// Settings Tab
// ============================================================================

class AutocompleteSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Text Autocomplete Settings' });

    new Setting(containerEl)
      .setName('Enable autocomplete')
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.enabled)
          .onChange(async (v) => {
            this.plugin.settings.enabled = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Max suggestions')
      .setDesc('3–10 suggestions')
      .addSlider((s) =>
        s
          .setLimits(3, 10, 1)
          .setValue(this.plugin.settings.maxSuggestions)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxSuggestions = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Min word length')
      .setDesc('2–5 characters before triggering')
      .addSlider((s) =>
        s
          .setLimits(2, 5, 1)
          .setValue(this.plugin.settings.minLength)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.minLength = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Add space after word')
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.addSpace)
          .onChange(async (v) => {
            this.plugin.settings.addSpace = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Enable in code blocks')
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.enableInCode)
          .onChange(async (v) => {
            this.plugin.settings.enableInCode = v;
            await this.plugin.saveSettings();
          }),
      );
  }
}

module.exports = TextAutocompletePlugin;
