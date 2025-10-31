const {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
} = require('obsidian');

const { EditorView, Decoration, ViewPlugin, WidgetType } = require('@codemirror/view');
const { StateEffect, StateField, Prec } = require('@codemirror/state');

// ============================================================================
// Optimized Trie
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

    const out = [];
    this._fuzzyDfs(this.root, '', '', query, firstRow, null, maxEdits, out, limit);

    out.sort((a, b) => a.dist - b.dist || a.word.localeCompare(b.word, undefined, { sensitivity: 'base' }));
    return out.slice(0, limit).map(x => x.word);
  }

  _fuzzyDfs(node, prefix, prevChar, query, prevRow, prevPrevRow, maxEdits, out, limit) {
    for (const [ch, child] of node.children) {
      const currRow = [prevRow[0] + 1];
      let rowMin = currRow[0];

      for (let j = 1; j < prevRow.length; j++) {
        const cost = query[j - 1] === ch ? 0 : 1;
        let v = Math.min(
          currRow[j - 1] + 1,
          prevRow[j] + 1,
          prevRow[j - 1] + cost
        );

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
        if (out.length > limit * 8) {
          out.sort((a, b) => a.dist - b.dist || a.word.localeCompare(b.word));
          out.length = limit * 4;
        }
      }

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
  maxSuggestions: 5,
  minLength: 3,
  addSpace: true,
  enableInCode: false,
};

// ============================================================================
// Ghost Text State
// ============================================================================

const SetSuggestionsEffect = StateEffect.define();
const CycleSuggestionEffect = StateEffect.define();
const ClearSuggestionsEffect = StateEffect.define();

const GhostTextState = StateField.define({
  create() {
    return null;
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(SetSuggestionsEffect)) {
        return effect.value;
      }
      if (effect.is(CycleSuggestionEffect)) {
        if (!value || value.suggestions.length === 0) return value;
        const newIndex = (value.currentIndex + effect.value + value.suggestions.length) % value.suggestions.length;
        return { ...value, currentIndex: newIndex };
      }
      if (effect.is(ClearSuggestionsEffect)) {
        return null;
      }
    }
    
    // Auto-clear on document changes or selection changes
    if (value && (transaction.docChanged || transaction.selection)) {
      const newPos = transaction.state.selection.main.head;
      if (newPos !== value.cursorPos) {
        return null;
      }
    }
    
    return value;
  },
});

// ============================================================================
// Ghost Text Widget
// ============================================================================

class GhostTextWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }

  eq(other) {
    return other.text === this.text;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ghost-text';
    span.textContent = this.text;
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

// ============================================================================
// Ghost Text Rendering
// ============================================================================

const GhostTextPlugin = Prec.lowest(
  ViewPlugin.fromClass(
    class {
      constructor() {
        this.decorations = Decoration.none;
      }

      update(update) {
        const state = update.state.field(GhostTextState);
        
        if (state && state.suggestions.length > 0) {
          const suggestion = state.suggestions[state.currentIndex];
          const widget = new GhostTextWidget(suggestion);
          const deco = Decoration.widget({
            widget,
            side: 1,
          });
          this.decorations = Decoration.set([deco.range(state.cursorPos)]);
        } else {
          this.decorations = Decoration.none;
        }
      }
    },
    {
      decorations: v => v.decorations,
    }
  )
);

// ============================================================================
// Key Handler
// ============================================================================

function createKeyHandler(plugin) {
  return Prec.high(
    EditorView.domEventHandlers({
      keydown(event, view) {
        const state = view.state.field(GhostTextState);
        
        if (!state || state.suggestions.length === 0) {
          return false;
        }
        
        // Tab - Accept suggestion
        if (event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          
          const suggestion = state.suggestions[state.currentIndex];
          const insert = suggestion + (plugin.settings.addSpace ? ' ' : '');
          
          view.dispatch({
            changes: {
              from: state.cursorPos,
              insert: insert,
            },
            selection: { anchor: state.cursorPos + insert.length },
            effects: ClearSuggestionsEffect.of(),
          });
          return true;
        }
        
        // Arrow Right - Next suggestion (only if multiple suggestions)
        if (event.key === 'ArrowRight' && state.suggestions.length > 1) {
          const selection = view.state.selection.main;
          // Only cycle if cursor is at the trigger position and no selection
          if (selection.from === selection.to && selection.head === state.cursorPos) {
            event.preventDefault();
            event.stopPropagation();
            view.dispatch({
              effects: CycleSuggestionEffect.of(1),
            });
            return true;
          }
        }
        
        // Arrow Left - Previous suggestion (only if multiple suggestions)
        if (event.key === 'ArrowLeft' && state.suggestions.length > 1) {
          const selection = view.state.selection.main;
          // Only cycle if cursor is at the trigger position and no selection
          if (selection.from === selection.to && selection.head === state.cursorPos) {
            event.preventDefault();
            event.stopPropagation();
            view.dispatch({
              effects: CycleSuggestionEffect.of(-1),
            });
            return true;
          }
        }
        
        // Escape - Clear suggestions
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          view.dispatch({
            effects: ClearSuggestionsEffect.of(),
          });
          return true;
        }
        
        return false;
      },
    })
  );
}

// ============================================================================
// Document Change Listener
// ============================================================================

function createChangeListener(plugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
      }

      update(update) {
        if (!plugin.settings.enabled || !update.view.hasFocus) {
          return;
        }
        
        // Only trigger on actual document changes with typing
        if (!update.docChanged) {
          return;
        }
        
        // Check for user input
        let isUserInput = false;
        for (const tr of update.transactions) {
          if (tr.isUserEvent('input.type')) {
            isUserInput = true;
            break;
          }
        }
        
        if (!isUserInput) {
          return;
        }
        
        const state = update.state;
        const pos = state.selection.main.head;
        
        // Don't trigger with multiple cursors
        if (state.selection.ranges.length > 1) {
          return;
        }
        
        // Don't trigger with selection
        if (state.selection.main.from !== state.selection.main.to) {
          return;
        }
        
        const line = state.doc.lineAt(pos);
        const lineText = line.text;
        const cursorInLine = pos - line.from;
        
        const before = lineText.slice(0, cursorInLine);
        const after = lineText.slice(cursorInLine);
        
        // Don't trigger mid-word
        if (/^[\p{L}\p{N}]/u.test(after)) {
          return;
        }
        
        // Extract current word being typed
        const match = before.match(/[\p{L}][\p{L}\p{N}']*$/u);
        if (!match) {
          return;
        }
        
        const word = match[0];
        if (word.length < plugin.settings.minLength) {
          return;
        }
        
        // Check code context
        if (!plugin.settings.enableInCode && plugin.isInCodeContext(state, pos)) {
          return;
        }
        
        // Delay slightly to debounce rapid typing
        setTimeout(() => {
          plugin.updateSuggestions(update.view, word, pos);
        }, 50);
      }
    }
  );
}

// ============================================================================
// Main Plugin
// ============================================================================

class TextAutocompletePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.trie = new Trie();
    await this.loadDictionary();

    // Register CodeMirror 6 extensions
    this.registerEditorExtension([
      GhostTextState,
      createKeyHandler(this),
      GhostTextPlugin,
      createChangeListener(this),
    ]);

    this.addSettingTab(new AutocompleteSettingTab(this.app, this));
    console.log('Text Autocomplete (Ghost Text) loaded');
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
      console.log('Dictionary loaded:', this.trie.root.children.size, 'root nodes');
    } catch (e) {
      console.error('Failed to load words.txt:', e);
    }
  }

  getSuggestions(prefix) {
    const limit = this.settings.maxSuggestions * 2; // Get more for filtering
    const exact = this.trie.search(prefix, limit);

    if (exact.length >= this.settings.maxSuggestions) {
      return exact.slice(0, this.settings.maxSuggestions);
    }

    const edits = this.allowedEdits(prefix);
    const fuzzy = this.trie.searchFuzzy(prefix, edits, limit * 3);

    const seen = new Set(exact.map(w => w.toLowerCase().normalize('NFC')));
    const merged = [...exact];
    
    for (const w of fuzzy) {
      const k = w.toLowerCase().normalize('NFC');
      if (!seen.has(k)) {
        merged.push(w);
        seen.add(k);
        if (merged.length >= this.settings.maxSuggestions) break;
      }
    }

    return merged.slice(0, this.settings.maxSuggestions);
  }

  updateSuggestions(view, prefix, cursorPos) {
    const suggestions = this.getSuggestions(prefix);
    
    // Filter and prepare completions (only the part after the prefix)
    const completions = suggestions
      .map(word => {
        const wordLower = word.toLowerCase();
        const prefixLower = prefix.toLowerCase();
        
        if (wordLower.startsWith(prefixLower) && word.length > prefix.length) {
          // Match case of original prefix, return only the completion part
          const matched = this.matchCase(word, prefix);
          return matched.slice(prefix.length);
        }
        return null;
      })
      .filter(s => s && s.length > 0);
    
    if (completions.length > 0) {
      view.dispatch({
        effects: SetSuggestionsEffect.of({
          suggestions: completions,
          currentIndex: 0,
          prefix: prefix,
          cursorPos: cursorPos,
        }),
      });
    }
  }

  allowedEdits(q) {
    const n = (q || '').toLowerCase().normalize('NFC').length;
    if (n <= 4) return 1;
    if (n <= 8) return 2;
    return 3;
  }

  matchCase(word, original) {
    if (!original || !word) return word;
    
    // All uppercase
    if (original === original.toUpperCase()) {
      return word.toUpperCase();
    }
    
    // First letter uppercase
    if (original[0] === original[0].toUpperCase()) {
      return word[0].toUpperCase() + word.slice(1).toLowerCase();
    }
    
    // All lowercase
    return word.toLowerCase();
  }

  isInCodeContext(state, pos) {
    // Check code blocks
    let inCodeBlock = false;
    let currentLine = 0;
    
    const doc = state.doc;
    const targetLine = doc.lineAt(pos).number;
    
    for (let i = 1; i <= targetLine; i++) {
      const line = doc.line(i);
      if (/^```/.test(line.text)) {
        inCodeBlock = !inCodeBlock;
      }
    }
    
    // Check inline code (backticks)
    const line = doc.lineAt(pos);
    const lineText = line.text;
    const cursorInLine = pos - line.from;
    const beforeInLine = lineText.slice(0, cursorInLine);
    const backtickCount = (beforeInLine.match(/`/g) || []).length;
    const inInlineCode = backtickCount % 2 === 1;
    
    return inCodeBlock || inInlineCode;
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
    
    containerEl.createEl('p', {
      text: '💡 Ghost text controls: Tab to accept, ←/→ to cycle, Esc to dismiss',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Enable autocomplete')
      .setDesc('Toggle ghost text suggestions')
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
      .setDesc('Number of suggestions to cycle through (3–10)')
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
      .setDesc('Characters before triggering suggestions (2–5)')
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
      .setDesc('Automatically add space when accepting suggestion')
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
      .setDesc('Show suggestions inside code blocks and inline code')
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