const { Plugin, PluginSettingTab, Setting } = require('obsidian');

// ============================================================================
// OPTIMIZED TRIE (Alphabetical sorting built-in)
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
        if (!word || word.length < 2) return;

        let node = this.root;
        for (const char of word.toLowerCase()) {
            if (!node.children.has(char)) {
                node.children.set(char, new TrieNode());
            }
            node = node.children.get(char);
        }
        node.isWord = true;
    }

    search(prefix, limit = 10) {
        if (!prefix) return [];

        let node = this.root;
        prefix = prefix.toLowerCase();

        // Navigate to prefix node
        for (const char of prefix) {
            node = node.children.get(char);
            if (!node) return [];
        }

        // Collect words alphabetically
        const results = [];
        this._collect(node, prefix, results, limit);
        return results;
    }

    _collect(node, prefix, results, limit) {
        if (results.length >= limit) return;

        if (node.isWord) results.push(prefix);

        // Process children in alphabetical order
        const chars = Array.from(node.children.keys()).sort();
        for (const char of chars) {
            if (results.length >= limit) break;
            this._collect(node.children.get(char), prefix + char, results, limit);
        }
    }
}

// ============================================================================
// AUTOCOMPLETE UI
// ============================================================================

class AutocompleteUI {
    constructor(plugin) {
        this.plugin = plugin;
        this.dropdown = null;
        this.selectedIndex = 0;
        this.suggestions = [];
    }

    show(suggestions, editor, wordStart, currentWord) {
        this.hide();
        if (!suggestions.length) return;

        this.suggestions = suggestions;
        this.selectedIndex = 0;
        this.wordStart = wordStart;
        this.currentWord = currentWord;

        this.dropdown = this._create(suggestions, editor);
        this._position(editor);
    }

    _create(suggestions, editor) {
        const dropdown = createDiv({ cls: 'autocomplete-dropdown' });
        const list = dropdown.createEl('ul', { cls: 'autocomplete-list' });

        suggestions.forEach((word, index) => {
            const item = list.createEl('li', {
                cls: 'autocomplete-item' + (index === 0 ? ' is-selected' : ''),
            });

            // Highlight prefix match
            const prefix = this.currentWord.toLowerCase();
            const matchLen = prefix.length;
            item.innerHTML = `<span class="autocomplete-match">${word.substring(0, matchLen)}</span>${word.substring(matchLen)}`;

            item.onmouseenter = () => this.select(index);
            item.onmousedown = (e) => {
                e.preventDefault();
                this.accept(editor);
            };
        });

        document.body.appendChild(dropdown);
        return dropdown;
    }

    _position(editor) {
        const coords = editor.cm.coordsAtPos(editor.posToOffset(editor.getCursor()));
        if (!coords) return;

        const { top, bottom, left } = coords;
        const { innerHeight, innerWidth } = window;
        const { offsetHeight, offsetWidth } = this.dropdown;

        this.dropdown.style.top = `${(bottom + offsetHeight > innerHeight ? top - offsetHeight : bottom) + window.scrollY}px`;
        this.dropdown.style.left = `${Math.min(left, innerWidth - offsetWidth - 10) + window.scrollX}px`;
    }

    select(index) {
        const items = this.dropdown.querySelectorAll('.autocomplete-item');
        items.forEach((item, i) => item.classList.toggle('is-selected', i === index));
        this.selectedIndex = index;
        items[index]?.scrollIntoView({ block: 'nearest' });
    }

    move(direction) {
        if (!this.dropdown) return false;
        const max = this.suggestions.length;
        this.selectedIndex = direction === 'down'
            ? (this.selectedIndex + 1) % max
            : (this.selectedIndex - 1 + max) % max;
        this.select(this.selectedIndex);
        return true;
    }

    accept(editor) {
        if (!this.dropdown) return false;

        const word = this.suggestions[this.selectedIndex];
        const suffix = this.plugin.settings.addSpace ? ' ' : '';

        editor.replaceRange(word + suffix, this.wordStart, editor.getCursor());
        this.hide();
        return true;
    }

    hide() {
        this.dropdown?.remove();
        this.dropdown = null;
        this.suggestions = [];
    }
}

// ============================================================================
// MAIN PLUGIN
// ============================================================================

const DEFAULT_SETTINGS = {
    enabled: true,
    maxSuggestions: 5,
    minLength: 3,
    addSpace: true,
    delay: 100,
    enableInCode: false
};

class TextAutocompletePlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.trie = new Trie();
        this.ui = new AutocompleteUI(this);
        this.timer = null;

        await this.loadDictionary();

        this.addSettingTab(new AutocompleteSettingTab(this.app, this));
        this.registerEditorEvents();
        this.registerKeyHandlers();

        console.log('Text Autocomplete loaded');
    }

    onunload() {
        this.ui.hide();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async loadDictionary() {
        try {
            const path = `${this.manifest.dir}/words.txt`;
            const content = await this.app.vault.adapter.read(path);
            content.split('\n').forEach(word => {
                word = word.trim();
                if (word) this.trie.insert(word);
            });
            console.log('Dictionary loaded');
        } catch (e) {
            console.error('Failed to load words.txt:', e);
        }
    }

    registerEditorEvents() {
        this.registerEvent(
            this.app.workspace.on('editor-change', (editor) => {
                if (!this.settings.enabled) return;

                clearTimeout(this.timer);
                this.timer = setTimeout(() => this.process(editor), this.settings.delay);
            })
        );
    }

    registerKeyHandlers() {
        this.registerDomEvent(document, 'keydown', (e) => {
            if (!this.ui.dropdown) return;

            const handlers = {
                'ArrowDown': () => this.ui.move('down'),
                'ArrowUp': () => this.ui.move('up'),
                'Enter': () => !e.shiftKey && this.ui.accept(this.getEditor()),
                'Tab': () => this.ui.accept(this.getEditor()),
                'Escape': () => this.ui.hide()
            };

            const handler = handlers[e.key];
            if (handler && handler()) e.preventDefault();
        }, true);

        this.registerDomEvent(document, 'click', (e) => {
            if (!e.target.closest('.autocomplete-dropdown')) this.ui.hide();
        });
    }

    process(editor) {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const before = line.substring(0, cursor.ch);
        const after = line.substring(cursor.ch);

        // Skip if in code block or middle of word
        if (!this.settings.enableInCode && this.isInCode(editor, cursor)) return this.ui.hide();
        if (/^[a-zA-Z0-9]/.test(after)) return this.ui.hide();

        // Extract current word
        const match = before.match(/[a-zA-Z][a-zA-Z0-9']*$/);
        if (!match || match[0].length < this.settings.minLength) return this.ui.hide();

        const word = match[0];
        const suggestions = this.getSuggestions(word);

        if (suggestions.length) {
            const wordStart = { line: cursor.line, ch: cursor.ch - word.length };
            this.ui.show(suggestions, editor, wordStart, word);
        } else {
            this.ui.hide();
        }
    }

    getSuggestions(word) {
        return this.trie
            .search(word, this.settings.maxSuggestions)
            .map(w => this.matchCase(w, word));
    }

    matchCase(word, original) {
        if (original === original.toUpperCase()) return word.toUpperCase();
        if (original[0] === original[0].toUpperCase()) {
            return word[0].toUpperCase() + word.slice(1).toLowerCase();
        }
        return word.toLowerCase();
    }

    isInCode(editor, cursor) {
        const lines = editor.getValue().split('\n');
        let inBlock = false;

        for (let i = 0; i <= cursor.line; i++) {
            if (/^```/.test(lines[i])) inBlock = !inBlock;
            if (i === cursor.line) {
                const before = lines[i].substring(0, cursor.ch);
                return inBlock || (before.match(/`/g) || []).length % 2 === 1;
            }
        }
        return false;
    }

    getEditor() {
        const view = this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
        return view?.editor;
    }
}

// ============================================================================
// SETTINGS TAB
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
            .addToggle(t => t.setValue(this.plugin.settings.enabled)
                .onChange(async (v) => {
                    this.plugin.settings.enabled = v;
                    if (!v) this.plugin.ui.hide();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Max suggestions')
            .setDesc('3-10 suggestions')
            .addSlider(s => s.setLimits(3, 10, 1)
                .setValue(this.plugin.settings.maxSuggestions)
                .setDynamicTooltip()
                .onChange(async (v) => {
                    this.plugin.settings.maxSuggestions = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Min word length')
            .setDesc('2-5 characters before triggering')
            .addSlider(s => s.setLimits(2, 5, 1)
                .setValue(this.plugin.settings.minLength)
                .setDynamicTooltip()
                .onChange(async (v) => {
                    this.plugin.settings.minLength = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Trigger delay (ms)')
            .setDesc('0-500ms delay')
            .addSlider(s => s.setLimits(0, 500, 50)
                .setValue(this.plugin.settings.delay)
                .setDynamicTooltip()
                .onChange(async (v) => {
                    this.plugin.settings.delay = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Add space after word')
            .addToggle(t => t.setValue(this.plugin.settings.addSpace)
                .onChange(async (v) => {
                    this.plugin.settings.addSpace = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Enable in code blocks')
            .addToggle(t => t.setValue(this.plugin.settings.enableInCode)
                .onChange(async (v) => {
                    this.plugin.settings.enableInCode = v;
                    await this.plugin.saveSettings();
                }));
    }
}

module.exports = TextAutocompletePlugin;