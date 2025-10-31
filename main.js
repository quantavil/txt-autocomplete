const { Plugin, PluginSettingTab, Setting, Notice, EditorSuggest } = require('obsidian');

// ============================================================================
// TRIE DATA STRUCTURE (Optimized with frequency scoring)
// ============================================================================

class TrieNode {
    constructor() {
        this.children = new Map();
        this.isWord = false;
        this.frequency = 0;
        this.word = null;
    }
}

class Trie {
    constructor() {
        this.root = new TrieNode();
        this.wordCount = 0;
    }

    insert(word, frequency = 1) {
        if (!word || word.length < 2) return;
        
        word = word.toLowerCase();
        let node = this.root;
        
        for (const char of word) {
            if (!node.children.has(char)) {
                node.children.set(char, new TrieNode());
            }
            node = node.children.get(char);
        }
        
        if (!node.isWord) {
            this.wordCount++;
        }
        node.isWord = true;
        node.word = word;
        node.frequency += frequency;
    }

    remove(word) {
        word = word.toLowerCase();
        this._removeHelper(this.root, word, 0);
    }

    _removeHelper(node, word, index) {
        if (index === word.length) {
            if (node.isWord) {
                node.isWord = false;
                node.word = null;
                this.wordCount--;
            }
            return node.children.size === 0;
        }

        const char = word[index];
        const childNode = node.children.get(char);
        
        if (!childNode) return false;

        const shouldDelete = this._removeHelper(childNode, word, index + 1);
        
        if (shouldDelete) {
            node.children.delete(char);
            return node.children.size === 0 && !node.isWord;
        }
        
        return false;
    }

    search(prefix, limit = 10, excludeWord = null) {
        if (!prefix || prefix.length === 0) return [];
        
        prefix = prefix.toLowerCase();
        let node = this.root;
        
        // Navigate to prefix
        for (const char of prefix) {
            if (!node.children.has(char)) return [];
            node = node.children.get(char);
        }
        
        // Collect words
        const results = [];
        this._collectWords(node, prefix, results, limit, excludeWord);
        
        // Sort by frequency (descending) then alphabetically
        results.sort((a, b) => {
            if (b.frequency !== a.frequency) {
                return b.frequency - a.frequency;
            }
            return a.word.localeCompare(b.word);
        });
        
        return results.slice(0, limit).map(r => r.word);
    }

    _collectWords(node, prefix, results, limit, excludeWord) {
        if (results.length >= limit) return;
        
        if (node.isWord && node.word !== excludeWord) {
            results.push({ word: node.word, frequency: node.frequency });
        }
        
        // Use DFS for efficient traversal
        for (const [char, childNode] of node.children) {
            if (results.length >= limit) break;
            this._collectWords(childNode, prefix + char, results, limit, excludeWord);
        }
    }

    // Fuzzy search (allows 1 character difference)
    fuzzySearch(prefix, limit = 10, excludeWord = null) {
        if (!prefix || prefix.length < 3) {
            return this.search(prefix, limit, excludeWord);
        }
        
        const results = new Map();
        prefix = prefix.toLowerCase();
        
        // Exact matches first
        const exact = this.search(prefix, limit, excludeWord);
        exact.forEach(word => results.set(word, { word, score: 100 }));
        
        if (results.size >= limit) {
            return Array.from(results.values())
                .sort((a, b) => b.score - a.score)
                .slice(0, limit)
                .map(r => r.word);
        }
        
        // Try one character substitution
        for (let i = 0; i < prefix.length; i++) {
            const before = prefix.slice(0, i);
            const after = prefix.slice(i + 1);
            
            for (let c = 97; c <= 122; c++) { // a-z
                const char = String.fromCharCode(c);
                if (char === prefix[i]) continue;
                
                const variant = before + char + after;
                const matches = this.search(variant, 5, excludeWord);
                
                matches.forEach(word => {
                    if (!results.has(word)) {
                        results.set(word, { word, score: 50 });
                    }
                });
                
                if (results.size >= limit * 2) break;
            }
            if (results.size >= limit * 2) break;
        }
        
        return Array.from(results.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(r => r.word);
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
        this.currentWord = '';
        this.wordStart = null;
        this.isVisible = false;
    }

    show(suggestions, editor, wordStart, currentWord) {
        this.destroy();
        
        if (!suggestions || suggestions.length === 0) return;
        
        this.suggestions = suggestions;
        this.currentWord = currentWord;
        this.wordStart = wordStart;
        this.selectedIndex = 0;
        this.isVisible = true;
        
        this.dropdown = this.createDropdown(suggestions, editor);
        this.position(editor);
    }

    createDropdown(suggestions, editor) {
        const dropdown = document.createElement('div');
        dropdown.className = 'autocomplete-dropdown';
        
        const list = document.createElement('ul');
        list.className = 'autocomplete-list';
        
        suggestions.forEach((suggestion, index) => {
            const item = document.createElement('li');
            item.className = 'autocomplete-item';
            if (index === 0) item.classList.add('is-selected');
            
            // Highlight matching prefix
            const prefix = this.currentWord.toLowerCase();
            const text = suggestion;
            const matchIndex = text.toLowerCase().indexOf(prefix);
            
            if (matchIndex !== -1) {
                const before = text.substring(0, matchIndex);
                const match = text.substring(matchIndex, matchIndex + prefix.length);
                const after = text.substring(matchIndex + prefix.length);
                
                item.innerHTML = `${this.escapeHtml(before)}<span class="autocomplete-match">${this.escapeHtml(match)}</span>${this.escapeHtml(after)}`;
            } else {
                item.textContent = text;
            }
            
            item.addEventListener('mouseenter', () => {
                this.setSelected(index);
            });
            
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.accept(editor);
            });
            
            list.appendChild(item);
        });
        
        dropdown.appendChild(list);
        document.body.appendChild(dropdown);
        
        return dropdown;
    }

    position(editor) {
        if (!this.dropdown) return;
        
        const cursor = editor.getCursor();
        const coords = editor.cm.coordsAtPos(editor.posToOffset(cursor));
        
        if (!coords) return;
        
        const dropdownHeight = this.dropdown.offsetHeight;
        const dropdownWidth = this.dropdown.offsetWidth;
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        
        let top = coords.bottom + window.scrollY;
        let left = coords.left + window.scrollX;
        
        // Adjust if dropdown goes off bottom of screen
        if (coords.bottom + dropdownHeight > viewportHeight) {
            top = coords.top + window.scrollY - dropdownHeight;
        }
        
        // Adjust if dropdown goes off right of screen
        if (coords.left + dropdownWidth > viewportWidth) {
            left = viewportWidth - dropdownWidth - 10;
        }
        
        this.dropdown.style.top = `${top}px`;
        this.dropdown.style.left = `${left}px`;
    }

    setSelected(index) {
        if (!this.dropdown) return;
        
        const items = this.dropdown.querySelectorAll('.autocomplete-item');
        items.forEach((item, i) => {
            item.classList.toggle('is-selected', i === index);
        });
        
        this.selectedIndex = index;
        
        // Scroll selected item into view
        const selectedItem = items[index];
        if (selectedItem) {
            selectedItem.scrollIntoView({ block: 'nearest' });
        }
    }

    moveSelection(direction) {
        if (!this.isVisible || this.suggestions.length === 0) return;
        
        if (direction === 'down') {
            this.selectedIndex = (this.selectedIndex + 1) % this.suggestions.length;
        } else if (direction === 'up') {
            this.selectedIndex = (this.selectedIndex - 1 + this.suggestions.length) % this.suggestions.length;
        }
        
        this.setSelected(this.selectedIndex);
    }

    accept(editor) {
        if (!this.isVisible || this.suggestions.length === 0) return false;
        
        const suggestion = this.suggestions[this.selectedIndex];
        const cursor = editor.getCursor();
        
        // Replace current word with suggestion
        editor.replaceRange(
            suggestion + (this.plugin.settings.addSpace ? ' ' : ''),
            this.wordStart,
            cursor
        );
        
        // Track usage for frequency
        this.plugin.trie.insert(suggestion, 1);
        this.plugin.learnWord(suggestion);
        
        this.destroy();
        return true;
    }

    destroy() {
        if (this.dropdown) {
            this.dropdown.remove();
            this.dropdown = null;
        }
        this.isVisible = false;
        this.suggestions = [];
        this.selectedIndex = 0;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// ============================================================================
// MAIN PLUGIN
// ============================================================================

const DEFAULT_SETTINGS = {
    enabled: true,
    maxSuggestions: 5,
    minWordLength: 3,
    addSpace: true,
    fuzzyMatch: false,
    learnFromDocument: true,
    learnFromVault: false,
    customWords: [],
    excludeWords: [],
    triggerDelay: 100,
    enableInCodeBlocks: false,
    caseSensitive: false
};

class TextAutocompletePlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        
        this.trie = new Trie();
        this.ui = new AutocompleteUI(this);
        this.typingTimer = null;
        this.documentWords = new Set();
        this.isProcessing = false;
        
        // Load dictionary
        await this.loadDictionary();
        
        // Add settings tab
        this.addSettingTab(new AutocompleteSettingTab(this.app, this));
        
        // Register event handlers
        this.registerEditorHandlers();
        this.registerDomHandlers();
        
        console.log('Advanced Text Autocomplete Plugin loaded');
    }

    onunload() {
        this.ui.destroy();
        console.log('Advanced Text Autocomplete Plugin unloaded');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async loadDictionary() {
        // Load custom words
        this.settings.customWords.forEach(word => {
            this.trie.insert(word, 5); // Higher frequency for custom words
        });
        
        // Load words.txt from plugin folder
        try {
            const adapter = this.app.vault.adapter;
            const pluginDir = this.manifest.dir || '.obsidian/plugins/advanced-text-autocomplete';
            const wordsPath = `${pluginDir}/words.txt`;
            
            if (await adapter.exists(wordsPath)) {
                const content = await adapter.read(wordsPath);
                const words = content.split('\n').filter(w => w.trim().length > 0);
                
                words.forEach(word => {
                    this.trie.insert(word.trim(), 1);
                });
                
                console.log(`Loaded ${words.length} words from dictionary`);
            } else {
                console.warn('words.txt not found, using custom words only');
            }
        } catch (error) {
            console.error('Error loading dictionary:', error);
            new Notice('Failed to load dictionary file');
        }
    }

    registerEditorHandlers() {
        this.registerEvent(
            this.app.workspace.on('editor-change', (editor) => {
                if (!this.settings.enabled) return;
                this.handleEditorChange(editor);
            })
        );

        // Learn from document when file is opened
        if (this.settings.learnFromDocument) {
            this.registerEvent(
                this.app.workspace.on('file-open', (file) => {
                    if (file) this.learnFromFile(file);
                })
            );
        }
    }

    registerDomHandlers() {
        this.registerDomEvent(document, 'keydown', (evt) => {
            if (!this.ui.isVisible) return;
            
            if (evt.key === 'ArrowDown') {
                evt.preventDefault();
                this.ui.moveSelection('down');
                return;
            }
            
            if (evt.key === 'ArrowUp') {
                evt.preventDefault();
                this.ui.moveSelection('up');
                return;
            }
            
            if (evt.key === 'Enter' && !evt.shiftKey) {
                if (this.ui.accept(this.getActiveEditor())) {
                    evt.preventDefault();
                }
                return;
            }
            
            if (evt.key === 'Tab') {
                if (this.ui.accept(this.getActiveEditor())) {
                    evt.preventDefault();
                }
                return;
            }
            
            if (evt.key === 'Escape') {
                this.ui.destroy();
                return;
            }
        }, true);

        // Close dropdown on click outside
        this.registerDomEvent(document, 'click', (evt) => {
            if (this.ui.isVisible && !evt.target.closest('.autocomplete-dropdown')) {
                this.ui.destroy();
            }
        });
    }

    handleEditorChange(editor) {
        if (this.isProcessing) return;
        
        clearTimeout(this.typingTimer);
        
        this.typingTimer = setTimeout(() => {
            this.processSuggestions(editor);
        }, this.settings.triggerDelay);
    }

    processSuggestions(editor) {
        this.isProcessing = true;
        
        try {
            const cursor = editor.getCursor();
            const line = editor.getLine(cursor.line);
            const beforeCursor = line.substring(0, cursor.ch);
            const afterCursor = line.substring(cursor.ch);
            
            // Check if in code block
            if (!this.settings.enableInCodeBlocks && this.isInCodeBlock(editor, cursor)) {
                this.ui.destroy();
                return;
            }
            
            // Don't show if cursor is in middle of word
            if (/^[a-zA-Z0-9]/.test(afterCursor)) {
                this.ui.destroy();
                return;
            }
            
            // Extract current word
            const wordMatch = beforeCursor.match(/[a-zA-Z][a-zA-Z0-9']*$/);
            if (!wordMatch) {
                this.ui.destroy();
                return;
            }
            
            const currentWord = wordMatch[0];
            
            // Check minimum length
            if (currentWord.length < this.settings.minWordLength) {
                this.ui.destroy();
                return;
            }
            
            // Get suggestions
            const suggestions = this.getSuggestions(currentWord);
            
            if (suggestions.length > 0) {
                const wordStart = {
                    line: cursor.line,
                    ch: cursor.ch - currentWord.length
                };
                
                this.ui.show(suggestions, editor, wordStart, currentWord);
            } else {
                this.ui.destroy();
            }
        } finally {
            this.isProcessing = false;
        }
    }

    getSuggestions(word) {
        const excludeWords = new Set([
            word.toLowerCase(),
            ...this.settings.excludeWords.map(w => w.toLowerCase())
        ]);
        
        let suggestions;
        
        if (this.settings.fuzzyMatch) {
            suggestions = this.trie.fuzzySearch(word, this.settings.maxSuggestions * 2, word.toLowerCase());
        } else {
            suggestions = this.trie.search(word, this.settings.maxSuggestions * 2, word.toLowerCase());
        }
        
        // Filter excluded words
        suggestions = suggestions.filter(s => !excludeWords.has(s.toLowerCase()));
        
        // Add document-specific words if enabled
        if (this.settings.learnFromDocument) {
            const docSuggestions = Array.from(this.documentWords)
                .filter(w => {
                    const lowerW = w.toLowerCase();
                    const lowerWord = word.toLowerCase();
                    return lowerW.startsWith(lowerWord) && 
                           !excludeWords.has(lowerW) &&
                           w.length >= this.settings.minWordLength;
                })
                .slice(0, 3);
            
            // Merge with dictionary suggestions (prioritize document words)
            suggestions = [...new Set([...docSuggestions, ...suggestions])];
        }
        
        // Handle case sensitivity
        if (!this.settings.caseSensitive) {
            suggestions = suggestions.map(s => this.matchCase(s, word));
        }
        
        return suggestions.slice(0, this.settings.maxSuggestions);
    }

    matchCase(suggestion, original) {
        if (original === original.toUpperCase()) {
            return suggestion.toUpperCase();
        }
        if (original[0] === original[0].toUpperCase()) {
            return suggestion[0].toUpperCase() + suggestion.slice(1).toLowerCase();
        }
        return suggestion.toLowerCase();
    }

    isInCodeBlock(editor, cursor) {
        const line = cursor.line;
        const content = editor.getValue();
        const lines = content.split('\n');
        
        let inCodeBlock = false;
        let inInlineCode = false;
        
        for (let i = 0; i <= line; i++) {
            const currentLine = lines[i];
            
            // Check for code block markers
            if (/^```/.test(currentLine.trim())) {
                inCodeBlock = !inCodeBlock;
            }
            
            // Check for inline code on current line
            if (i === line) {
                const beforeCursor = currentLine.substring(0, cursor.ch);
                const backticks = (beforeCursor.match(/`/g) || []).length;
                inInlineCode = backticks % 2 === 1;
            }
        }
        
        return inCodeBlock || inInlineCode;
    }

    async learnFromFile(file) {
        if (!this.settings.learnFromDocument) return;
        
        try {
            const content = await this.app.vault.read(file);
            const words = content.match(/\b[a-zA-Z][a-zA-Z0-9']{2,}\b/g) || [];
            
            this.documentWords.clear();
            words.forEach(word => {
                if (word.length >= this.settings.minWordLength) {
                    this.documentWords.add(word);
                }
            });
        } catch (error) {
            console.error('Error learning from file:', error);
        }
    }

    learnWord(word) {
        if (this.settings.learnFromDocument && word.length >= this.settings.minWordLength) {
            this.documentWords.add(word);
        }
    }

    getActiveEditor() {
        const view = this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
        return view ? view.editor : null;
    }

    async addCustomWord(word) {
        word = word.trim();
        if (!word || this.settings.customWords.includes(word)) return;
        
        this.settings.customWords.push(word);
        this.trie.insert(word, 5);
        await this.saveSettings();
    }

    async removeCustomWord(word) {
        const index = this.settings.customWords.indexOf(word);
        if (index === -1) return;
        
        this.settings.customWords.splice(index, 1);
        this.trie.remove(word);
        await this.saveSettings();
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
        
        containerEl.createEl('h2', { text: 'Advanced Text Autocomplete Settings' });
        
        // Enable/Disable
        new Setting(containerEl)
            .setName('Enable autocomplete')
            .setDesc('Toggle autocomplete functionality on/off')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enabled)
                .onChange(async (value) => {
                    this.plugin.settings.enabled = value;
                    if (!value) this.plugin.ui.destroy();
                    await this.plugin.saveSettings();
                }));
        
        // Max suggestions
        new Setting(containerEl)
            .setName('Maximum suggestions')
            .setDesc('Maximum number of suggestions to show (3-10)')
            .addSlider(slider => slider
                .setLimits(3, 10, 1)
                .setValue(this.plugin.settings.maxSuggestions)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxSuggestions = value;
                    await this.plugin.saveSettings();
                }));
        
        // Minimum word length
        new Setting(containerEl)
            .setName('Minimum word length')
            .setDesc('Minimum characters before showing suggestions (2-5)')
            .addSlider(slider => slider
                .setLimits(2, 5, 1)
                .setValue(this.plugin.settings.minWordLength)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.minWordLength = value;
                    await this.plugin.saveSettings();
                }));
        
        // Trigger delay
        new Setting(containerEl)
            .setName('Trigger delay')
            .setDesc('Delay in milliseconds before showing suggestions (0-500ms)')
            .addSlider(slider => slider
                .setLimits(0, 500, 50)
                .setValue(this.plugin.settings.triggerDelay)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.triggerDelay = value;
                    await this.plugin.saveSettings();
                }));
        
        // Add space after completion
        new Setting(containerEl)
            .setName('Add space after completion')
            .setDesc('Automatically add a space after accepting a suggestion')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.addSpace)
                .onChange(async (value) => {
                    this.plugin.settings.addSpace = value;
                    await this.plugin.saveSettings();
                }));
        
        // Fuzzy matching
        new Setting(containerEl)
            .setName('Fuzzy matching')
            .setDesc('Allow suggestions with small typos (may be slower)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.fuzzyMatch)
                .onChange(async (value) => {
                    this.plugin.settings.fuzzyMatch = value;
                    await this.plugin.saveSettings();
                }));
        
        // Learn from document
        new Setting(containerEl)
            .setName('Learn from document')
            .setDesc('Include words from current document in suggestions')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.learnFromDocument)
                .onChange(async (value) => {
                    this.plugin.settings.learnFromDocument = value;
                    await this.plugin.saveSettings();
                }));
        
        // Enable in code blocks
        new Setting(containerEl)
            .setName('Enable in code blocks')
            .setDesc('Show suggestions inside code blocks')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableInCodeBlocks)
                .onChange(async (value) => {
                    this.plugin.settings.enableInCodeBlocks = value;
                    await this.plugin.saveSettings();
                }));
        
        // Custom words section
        containerEl.createEl('h3', { text: 'Custom Dictionary' });
        
        // Add custom word
        new Setting(containerEl)
            .setName('Add custom word')
            .setDesc('Add a word to your custom dictionary')
            .addText(text => {
                text.setPlaceholder('Enter word...');
                text.inputEl.addEventListener('keydown', async (e) => {
                    if (e.key === 'Enter') {
                        const word = text.getValue().trim();
                        if (word) {
                            await this.plugin.addCustomWord(word);
                            text.setValue('');
                            this.display();
                            new Notice(`Added "${word}" to custom dictionary`);
                        }
                    }
                });
            })
            .addButton(button => button
                .setButtonText('Add')
                .onClick(async () => {
                    const input = containerEl.querySelector('input[type="text"]');
                    const word = input.value.trim();
                    if (word) {
                        await this.plugin.addCustomWord(word);
                        input.value = '';
                        this.display();
                        new Notice(`Added "${word}" to custom dictionary`);
                    }
                }));
        
        // Display custom words
        if (this.plugin.settings.customWords.length > 0) {
            const wordsContainer = containerEl.createDiv('custom-words-container');
            
            this.plugin.settings.customWords.forEach(word => {
                new Setting(wordsContainer)
                    .setName(word)
                    .addButton(button => button
                        .setButtonText('Remove')
                        .setWarning()
                        .onClick(async () => {
                            await this.plugin.removeCustomWord(word);
                            this.display();
                            new Notice(`Removed "${word}" from custom dictionary`);
                        }));
            });
        }
        
        // Clear all custom words
        if (this.plugin.settings.customWords.length > 0) {
            new Setting(containerEl)
                .setName('Clear custom dictionary')
                .setDesc('Remove all custom words')
                .addButton(button => button
                    .setButtonText('Clear All')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.customWords.forEach(word => {
                            this.plugin.trie.remove(word);
                        });
                        this.plugin.settings.customWords = [];
                        await this.plugin.saveSettings();
                        this.display();
                        new Notice('Cleared custom dictionary');
                    }));
        }
    }
}

module.exports = TextAutocompletePlugin;