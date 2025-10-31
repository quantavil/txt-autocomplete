const { Plugin, PluginSettingTab, Setting, normalizePath } = require('obsidian');
const { EditorView, Decoration, ViewPlugin, WidgetType } = require('@codemirror/view');
const { StateEffect, StateField, Prec } = require('@codemirror/state');

/* ============================================================================
   Trie
   ============================================================================ */

class TrieNode {
  children = new Map();
  isWord = false;
}

class Trie {
  constructor() { this.root = new TrieNode(); }

  insert(word) {
    if (!word) return;
    let node = this.root;
    for (const ch of word.toLowerCase()) {
      if (!node.children.has(ch)) node.children.set(ch, new TrieNode());
      node = node.children.get(ch);
    }
    node.isWord = true;
  }

  search(prefix, limit = 5) {
    if (!prefix || limit <= 0) return [];
    const lower = prefix.toLowerCase();
    let node = this.root;
    for (const ch of lower) {
      node = node.children.get(ch);
      if (!node) return [];
    }
    const results = [];
    this._collect(node, lower, results, limit);
    return results;
  }

  searchFuzzy(term, maxEdits, limit = 5) {
    if (!term || limit <= 0 || maxEdits <= 0) return [];
    const query = term.toLowerCase();
    const firstRow = Array.from({ length: query.length + 1 }, (_, i) => i);
    const results = [];
    this._fuzzyDfs(this.root, '', '', query, firstRow, null, maxEdits, results, limit);
    results.sort((a, b) => a.dist - b.dist || a.word.localeCompare(b.word));
    return results.slice(0, limit);
  }

  _fuzzyDfs(node, prefix, prevChar, query, prevRow, prevPrevRow, maxEdits, results, limit) {
    for (const [ch, child] of node.children) {
      const currRow = [prevRow[0] + 1];
      let rowMin = currRow[0];
      for (let j = 1; j < prevRow.length; j++) {
        const cost = query[j - 1] === ch ? 0 : 1;
        let val = Math.min(
          currRow[j - 1] + 1,      // insertion
          prevRow[j] + 1,          // deletion
          prevRow[j - 1] + cost    // substitution
        );
        if (prevPrevRow && j > 1 && ch === query[j - 2] && prevChar === query[j - 1]) {
          val = Math.min(val, prevPrevRow[j - 2] + 1); // transposition
        }
        currRow[j] = val;
        if (val < rowMin) rowMin = val;
      }
      const newPrefix = prefix + ch;
      const dist = currRow[currRow.length - 1];
      if (child.isWord && dist <= maxEdits) {
        results.push({ word: newPrefix, dist });
        if (results.length > limit * 4) {
          results.sort((a, b) => a.dist - b.dist);
          results.length = limit * 2;
        }
      }
      if (rowMin <= maxEdits) {
        this._fuzzyDfs(child, newPrefix, ch, query, currRow, prevRow, maxEdits, results, limit);
      }
    }
  }

  _collect(node, prefix, results, limit) {
    if (results.length >= limit) return;
    if (node.isWord) results.push(prefix);
    // Deterministic order for nicer UX
    for (const k of [...node.children.keys()].sort()) {
      if (results.length >= limit) break;
      this._collect(node.children.get(k), prefix + k, results, limit);
    }
  }
}

/* ============================================================================
   Settings
   ============================================================================ */

const DEFAULT_SETTINGS = {
  enabled: true,
  maxSuggestions: 5,
  minLength: 3,
  addSpace: true,
  enableInCode: false,
  fuzzyEdits: 2,
};

/* ============================================================================
   Effects & State
   ============================================================================ */

const SetSuggestionsEffect = StateEffect.define();     // value: { suggestions, currentIndex, cursorPos }
const CycleSuggestionEffect = StateEffect.define();    // value: +1 | -1
const ClearSuggestionsEffect = StateEffect.define();

const GhostTextState = StateField.define({
  create: () => null,

  update(value, tr) {
    // Handle explicit effects first
    for (const effect of tr.effects) {
      if (effect.is(SetSuggestionsEffect)) return effect.value;
      if (effect.is(ClearSuggestionsEffect)) return null;
      if (effect.is(CycleSuggestionEffect) && value?.suggestions?.length > 1) {
        const len = value.suggestions.length;
        const idx = (value.currentIndex + effect.value + len) % len;
        return { ...value, currentIndex: idx };
      }
    }

    if (!value) return value;

    // Clear when the document change touches the caret or the fuzzy-range
    if (tr.docChanged) {
      const { cursorPos } = value;
      let touched = false;

      // Change touches caret position (includes insertions at caret)
      tr.changes.iterChanges((fromA, toA) => {
        if (fromA <= cursorPos && cursorPos <= toA) touched = true;
      });

      // Also clear if current suggestion is fuzzy and the replaced prefix gets touched
      if (!touched) {
        const s = value.suggestions[value.currentIndex];
        if (s?.isFuzzy) {
          const a = s.wordStart;
          const b = value.cursorPos;
          tr.changes.iterChanges((fromA, toA) => {
            // overlap between [a, b] and [fromA, toA]
            if (!(toA < a || fromA > b)) touched = true;
          });
        }
      }

      if (touched) return null;

      // Map positions across edits elsewhere
      const mappedCursor = tr.changes.mapPos(value.cursorPos, 1);
      const mappedSuggestions = value.suggestions.map(s =>
        s.isFuzzy ? { ...s, wordStart: tr.changes.mapPos(s.wordStart, -1) } : s
      );
      value = { ...value, cursorPos: mappedCursor, suggestions: mappedSuggestions };
    }

    // Clear when caret moved away
    if (tr.selection && tr.state.selection.main.head !== value.cursorPos) return null;

    return value;
  },
});

/* ============================================================================
   Widget & Decorations
   ============================================================================ */

class GhostTextWidget extends WidgetType {
  constructor(text, isFuzzy) {
    super();
    this.text = text;
    this.isFuzzy = isFuzzy;
  }
  eq(other) { return other.text === this.text && other.isFuzzy === this.isFuzzy; }
  toDOM() {
    const span = document.createElement('span');
    span.className = this.isFuzzy ? 'cm-ghost-text cm-ghost-fuzzy' : 'cm-ghost-text';
    if (this.isFuzzy) {
      const arrow = document.createElement('span');
      arrow.className = 'cm-ghost-arrow';
      arrow.textContent = '→';
      span.append(arrow, this.text);
    } else {
      span.textContent = this.text;
    }
    return span;
  }
  ignoreEvent() { return false; }
}

const GhostTextPlugin = Prec.lowest(
  ViewPlugin.fromClass(
    class {
      constructor() { this.decorations = Decoration.none; }
      update(update) {
        const state = update.state.field(GhostTextState, false);
        if (state?.suggestions?.length) {
          const { text, isFuzzy } = state.suggestions[state.currentIndex];
          const deco = Decoration.widget({ widget: new GhostTextWidget(text, isFuzzy), side: 1 });
          this.decorations = Decoration.set([deco.range(state.cursorPos)]);
        } else {
          this.decorations = Decoration.none;
        }
      }
    },
    { decorations: v => v.decorations }
  )
);

/* ============================================================================
   Key Handler (Tab accept, ←/→ cycle, Esc clear)
   ============================================================================ */

const createKeyHandler = plugin => Prec.high(
  EditorView.domEventHandlers({
    keydown(event, view) {
      const state = view.state.field(GhostTextState, false);
      if (!state?.suggestions?.length) return false;

      const { key } = event;
      const sel = view.state.selection.main;
      const atCursor = sel.from === sel.to && sel.head === state.cursorPos;

      if (key === 'Tab') {
        event.preventDefault(); event.stopPropagation();
        const { text, isFuzzy, wordStart } = state.suggestions[state.currentIndex];
        const from = isFuzzy ? wordStart : state.cursorPos;
        const to = state.cursorPos;

        // Optional: only add trailing space if desired
        let insert = text;
        if (plugin.settings.addSpace) insert += ' ';

        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
          effects: ClearSuggestionsEffect.of(),
        });
        return true;
      }

      if (key === 'ArrowRight' && atCursor && state.suggestions.length > 1) {
        event.preventDefault(); event.stopPropagation();
        view.dispatch({ effects: CycleSuggestionEffect.of(1) });
        return true;
      }

      if (key === 'ArrowLeft' && atCursor && state.suggestions.length > 1) {
        event.preventDefault(); event.stopPropagation();
        view.dispatch({ effects: CycleSuggestionEffect.of(-1) });
        return true;
      }

      if (key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        view.dispatch({ effects: ClearSuggestionsEffect.of() });
        return true;
      }

      return false;
    },
  })
);

/* ============================================================================
   Change Listener (debounced)
   ============================================================================ */

const createChangeListener = plugin => ViewPlugin.fromClass(
  class {
    constructor(view) { this.view = view; this.timeout = null; }
    update(update) {
      if (!plugin.settings.enabled || !update.view.hasFocus || !update.docChanged) return;
      if (!update.transactions.some(tr => tr.isUserEvent('input.type'))) return;

      const { selection, doc } = update.state;
      if (selection.ranges.length > 1 || !selection.main.empty) return;

      const pos = selection.main.head;
      const line = doc.lineAt(pos);
      const before = line.text.slice(0, pos - line.from);
      const after = line.text.slice(pos - line.from);

      if (/^[\p{L}\p{N}]/u.test(after)) return; // mid-word
      const match = before.match(/[\p{L}][\p{L}\p{N}']*$/u);
      if (!match || match[0].length < plugin.settings.minLength) return;

      if (!plugin.settings.enableInCode && plugin.isInCodeContext(update.state, pos)) return;

      clearTimeout(this.timeout);
      this.timeout = setTimeout(() => {
        if (!plugin.settings.enabled || this.view.state.selection.main.head !== pos) return;
        plugin.updateSuggestions(this.view, match[0], pos, pos - match[0].length);
      }, 50);
    }
    destroy() { clearTimeout(this.timeout); }
  }
);

/* ============================================================================
   Main Plugin
   ============================================================================ */

class TextAutocompletePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.trie = new Trie();
    await this.loadDictionary();

    this.registerEditorExtension([
      GhostTextState,
      createKeyHandler(this),
      GhostTextPlugin,
      createChangeListener(this),
    ]);

    this.addSettingTab(new AutocompleteSettingTab(this.app, this));
  }

  async loadSettings() { this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) }; }
  async saveSettings() { await this.saveData(this.settings); }

  async loadDictionary() {
    try {
      const path = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/words.txt`);
      const content = await this.app.vault.adapter.read(path);
      for (const line of content.split('\n')) {
        const word = line.trim();
        if (word) this.trie.insert(word);
      }
    } catch (e) {
      console.error('Failed to load dictionary:', e);
    }
  }

  getSuggestions(prefix) {
    const limit = this.settings.maxSuggestions;
    const exact = this.trie.search(prefix, limit * 2);
    if (exact.length >= limit || this.settings.fuzzyEdits <= 0) return exact.slice(0, limit);

    const fuzzy = this.trie.searchFuzzy(prefix, this.settings.fuzzyEdits, limit * 3);
    const seen = new Set(exact.map(w => w.toLowerCase()));
    for (const { word } of fuzzy) {
      const lower = word.toLowerCase();
      if (!seen.has(lower) && lower !== prefix.toLowerCase()) {
        exact.push(word); seen.add(lower);
        if (exact.length >= limit) break;
      }
    }
    return exact.slice(0, limit);
  }

  updateSuggestions(view, prefix, cursorPos, wordStart) {
    if (!this.settings.enabled) return;
    const words = this.getSuggestions(prefix);
    const prefixLower = prefix.toLowerCase();

    const suggestions = words.map(word => {
      const wordLower = word.toLowerCase();
      const matched = this.matchCase(word, prefix);
      if (wordLower.startsWith(prefixLower) && word.length > prefix.length) {
        return { text: matched.slice(prefix.length), isFuzzy: false, wordStart: cursorPos };
      }
      if (wordLower !== prefixLower) {
        return { text: matched, isFuzzy: true, wordStart };
      }
      return null;
    }).filter(Boolean);

    view.dispatch({
      effects: (suggestions.length
        ? SetSuggestionsEffect.of({ suggestions, currentIndex: 0, cursorPos })
        : ClearSuggestionsEffect.of())
    });
  }

  matchCase(word, original) {
    if (!original) return word;
    if (original === original.toUpperCase()) return word.toUpperCase();
    if (original[0] === original[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1).toLowerCase();
    return word.toLowerCase();
  }

  // Keep simple detection as in your original (no advanced fix requested)
  isInCodeContext(state, pos) {
    const { doc } = state;
    const targetLine = doc.lineAt(pos).number;
    let inCodeBlock = false;
    for (let i = 1; i <= targetLine; i++) if (/^```/.test(doc.line(i).text)) inCodeBlock = !inCodeBlock;
    const line = doc.lineAt(pos);
    const beforeCursor = line.text.slice(0, pos - line.from);
    const backticks = (beforeCursor.match(/`/g) || []).length;
    return inCodeBlock || (backticks % 2 === 1);
  }

  clearAllEditors() {
    this.app.workspace.iterateAllLeaves(leaf => {
      const cm = leaf?.view?.editor?.cm;
      if (cm) cm.dispatch({ effects: ClearSuggestionsEffect.of() });
    });
  }
}

/* ============================================================================
   Settings Tab
   ============================================================================ */

class AutocompleteSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Text Autocomplete' });
    containerEl.createEl('p', { text: '⌨️ Tab: accept | ←/→: cycle | Esc: dismiss', cls: 'setting-item-description' });

    new Setting(containerEl)
      .setName('Enable')
      .addToggle(t => t
        .setValue(this.plugin.settings.enabled)
        .onChange(async v => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
          if (!v) this.plugin.clearAllEditors();
        })
      );

    new Setting(containerEl)
      .setName('Max suggestions')
      .setDesc('Number of suggestions to show')
      .addSlider(s => s
        .setLimits(3, 10, 1)
        .setValue(this.plugin.settings.maxSuggestions)
        .setDynamicTooltip()
        .onChange(async v => { this.plugin.settings.maxSuggestions = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName('Min word length')
      .setDesc('Minimum characters before triggering')
      .addSlider(s => s
        .setLimits(2, 5, 1)
        .setValue(this.plugin.settings.minLength)
        .setDynamicTooltip()
        .onChange(async v => { this.plugin.settings.minLength = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName('Fuzzy match distance')
      .setDesc('Maximum character edits for fuzzy matching (0 = disabled)')
      .addSlider(s => s
        .setLimits(0, 3, 1)
        .setValue(this.plugin.settings.fuzzyEdits)
        .setDynamicTooltip()
        .onChange(async v => { this.plugin.settings.fuzzyEdits = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName('Add space after word')
      .addToggle(t => t
        .setValue(this.plugin.settings.addSpace)
        .onChange(async v => { this.plugin.settings.addSpace = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName('Enable in code blocks')
      .addToggle(t => t
        .setValue(this.plugin.settings.enableInCode)
        .onChange(async v => { this.plugin.settings.enableInCode = v; await this.plugin.saveSettings(); })
      );
  }
}

module.exports = TextAutocompletePlugin;