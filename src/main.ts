import {
	Notice,
	Plugin,
	normalizePath,
	type Editor,
	MarkdownView,
} from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

import type { PluginSettings, SavedData, SuggestionItem, WordContext } from "./types";
import { Trie } from "./trie";
import { DEFAULT_SETTINGS, AutocompleteSettingTab } from "./settings";
import {
	GhostTextState,
	GhostTextPlugin,
	createEditorKeymap,
	createChangeListener,
	SetSuggestionsEffect,
	ClearSuggestionsEffect,
	CycleSuggestionEffect,
} from "./editor";

export default class TextAutocompletePlugin extends Plugin {
	public settings: PluginSettings = DEFAULT_SETTINGS;
	public data: SavedData = {};

	public trie = new Trie();
	private dictionaryLoaded = false;

	public override async onload(): Promise<void> {
		await this.loadSettings();

		this.registerEditorExtension([
			GhostTextState,
			createEditorKeymap(this),
			GhostTextPlugin,
			createChangeListener(this),
		]);

		this.registerCommands();
		this.addSettingTab(new AutocompleteSettingTab(this.app, this));

		const reloadOnDictionaryChange = (file: { path: string }): void => {
			if (file.path === this.getDictionaryPath()) {
				void this.reloadDictionary(false);
			}
		};

		this.registerEvent(this.app.vault.on("create", reloadOnDictionaryChange));
		this.registerEvent(this.app.vault.on("modify", reloadOnDictionaryChange));
		this.registerEvent(this.app.vault.on("delete", reloadOnDictionaryChange));

		void this.reloadDictionary(true);
	}

	public override onunload(): void {
		this.clearAllEditors();
	}

	public async loadSettings(): Promise<void> {
		const savedData = await this.loadData() as SavedData | null;
		this.data = savedData || {};

		this.settings = {
			...DEFAULT_SETTINGS,
			...(this.data.settings || {}),
		};
	}

	public async saveSettings(): Promise<void> {
		this.data.settings = this.settings;
		await this.saveData(this.data);
	}

	public async saveWords(): Promise<void> {
		await this.saveData(this.data);
	}

	public getDictionaryPath(): string {
		return normalizePath(
			`${this.app.vault.configDir}/plugins/${this.manifest.id}/words.txt`,
		);
	}

	public async reloadDictionary(showNoticeOnError = true): Promise<void> {
		this.trie = new Trie();
		this.dictionaryLoaded = false;

		const dictPath = this.getDictionaryPath();

		try {
			if (!(await this.app.vault.adapter.exists(dictPath))) {
				await this.app.vault.adapter.write(dictPath, "example\nwords\n");
			}

			const content = await this.app.vault.adapter.read(dictPath);

			const words = content
				.split(/\r?\n/u)
				.map((line) => line.trim())
				.filter(Boolean)
				.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

			for (const word of words) {
				this.trie.insert(word);
			}

			// Add user words to the trie as well
			if (this.data.userWords) {
				for (const word of this.data.userWords) {
					// We only insert if it's not ignored
					if (!this.data.ignoredWords?.includes(word.toLowerCase())) {
						this.trie.insert(word);
					}
				}
			}

			this.dictionaryLoaded = true;
			this.clearAllEditors();
		} catch (error) {
			console.error("Txt Autocomplete: failed to load words.txt", error);
			this.clearAllEditors();

			if (showNoticeOnError) {
				new Notice("Txt Autocomplete: words.txt could not be loaded.");
			}
		}
	}

	public refreshSuggestionsAtCursor(view: EditorView): void {
		if (!this.settings.enabled || !this.dictionaryLoaded) {
			this.dismissSuggestions(view);
			return;
		}

		const context = this.getWordContext(view.state);
		if (!context) {
			this.dismissSuggestions(view);
			return;
		}

		if (!this.settings.enableInCode && this.isInCodeContext(view.state, context.cursorPos)) {
			this.dismissSuggestions(view);
			return;
		}

		const words = this.getSuggestions(context.prefix);
		if (!words.length) {
			this.dismissSuggestions(view);
			return;
		}

		const prefixLower = context.prefix.toLowerCase();
		const suggestions: SuggestionItem[] = [];

		for (const word of words) {
			const wordLower = word.toLowerCase();
			if (wordLower === prefixLower) continue;

			// Do not suggest ignored words
			if (this.data.ignoredWords?.includes(wordLower)) {
				continue;
			}

			const matched = this.matchCase(word, context.prefix);

			if (wordLower.startsWith(prefixLower) && matched.length > context.prefix.length) {
				suggestions.push({
					text: matched.slice(context.prefix.length),
					isFuzzy: false,
					wordStart: context.wordStart,
				});
				continue;
			}

			suggestions.push({
				text: matched,
				isFuzzy: true,
				wordStart: context.wordStart,
			});
		}

		if (!suggestions.length) {
			this.dismissSuggestions(view);
			return;
		}

		view.dispatch({
			effects: SetSuggestionsEffect.of({
				suggestions,
				currentIndex: 0,
				cursorPos: context.cursorPos,
			}),
		});
	}

	public acceptSuggestion(view: EditorView): boolean {
		if (!this.hasActiveSuggestion(view)) return false;

		const session = this.getGhostSession(view)!;
		const suggestion = session.suggestions[session.currentIndex];
		if (!suggestion) return false;

		const from = suggestion.isFuzzy ? suggestion.wordStart : session.cursorPos;
		const to = session.cursorPos;

		let insert = suggestion.text;
		if (this.shouldAppendSpace(view, to)) {
			insert += " ";
		}

		view.dispatch({
			changes: { from, to, insert },
			selection: { anchor: from + insert.length },
			effects: ClearSuggestionsEffect.of(null),
		});

		return true;
	}

	public cycleSuggestion(view: EditorView, direction: 1 | -1): boolean {
		if (!this.hasActiveSuggestion(view, true)) return false;

		view.dispatch({
			effects: CycleSuggestionEffect.of(direction),
		});

		return true;
	}

	public dismissSuggestions(view: EditorView): boolean {
		const session = this.getGhostSession(view);
		if (!session) return false;

		view.dispatch({
			effects: ClearSuggestionsEffect.of(null),
		});

		return true;
	}

	public clearAllEditors(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const markdownView = leaf.view instanceof MarkdownView ? leaf.view : null;
			const editorView = this.getEditorView(markdownView);

			if (!editorView) return;

			editorView.dispatch({
				effects: ClearSuggestionsEffect.of(null),
			});
		});
	}

	private addEditorCommand(
		id: string,
		name: string,
		requireMultiple: boolean,
		action: (view: EditorView) => boolean
	) {
		this.addCommand({
			id,
			name,
			editorCheckCallback: (checking, _editor, markdownView) => {
				const editorView = this.getEditorView(markdownView as MarkdownView | null);
				const canRun = !!editorView && this.hasActiveSuggestion(editorView, requireMultiple);

				if (checking) return canRun;
				return editorView ? action(editorView) : false;
			},
		});
	}

	private registerCommands(): void {
		this.addEditorCommand("accept-autocomplete-suggestion", "Accept autocomplete suggestion", false, (view) => this.acceptSuggestion(view));
		this.addEditorCommand("next-autocomplete-suggestion", "Next autocomplete suggestion", true, (view) => this.cycleSuggestion(view, 1));
		this.addEditorCommand("previous-autocomplete-suggestion", "Previous autocomplete suggestion", true, (view) => this.cycleSuggestion(view, -1));
		this.addEditorCommand("dismiss-autocomplete-suggestions", "Dismiss autocomplete suggestions", false, (view) => this.dismissSuggestions(view));

		this.addCommand({
			id: "reload-autocomplete-dictionary",
			name: "Reload autocomplete dictionary",
			callback: async () => {
				await this.reloadDictionary(true);
			},
		});

		this.addCommand({
			id: "scan-vault-words",
			name: "Scan vault for new words",
			callback: async () => {
				const { scanVault } = await import("./scanner");
				await scanVault(this);
			},
		});
	}

	private getSuggestions(prefix: string): string[] {
		if (!this.dictionaryLoaded) return [];

		const limit = this.settings.maxSuggestions;
		const prefixLower = prefix.toLowerCase();

		const exact = this.trie
			.search(prefix, limit * 3)
			.filter((word) => word.toLowerCase() !== prefixLower);

		if (
			exact.length >= limit ||
			this.settings.fuzzyEdits <= 0 ||
			prefix.length < this.settings.fuzzyMinLength
		) {
			return exact.slice(0, limit);
		}

		const fuzzy = this.trie.searchFuzzy(
			prefix,
			this.settings.fuzzyEdits,
			limit * 4,
		);

		const seen = new Set(exact.map((word) => word.toLowerCase()));

		for (const { word } of fuzzy) {
			const lower = word.toLowerCase();
			if (lower === prefixLower || seen.has(lower)) continue;

			exact.push(word);
			seen.add(lower);

			if (exact.length >= limit) break;
		}

		return exact.slice(0, limit);
	}

	private getWordContext(state: EditorState): WordContext | null {
		const { selection, doc } = state;
		if (selection.ranges.length > 1 || !selection.main.empty) return null;

		const cursorPos = selection.main.head;
		const line = doc.lineAt(cursorPos);
		const offset = cursorPos - line.from;

		const before = line.text.slice(0, offset);
		const after = line.text.slice(offset);

		if (/^[\p{L}\p{N}'’]/u.test(after)) return null;

		const match = before.match(/[\p{L}][\p{L}\p{N}'’]*$/u);
		if (!match) return null;

		const prefix = match[0];
		if (prefix.length < this.settings.minLength) return null;

		return {
			prefix,
			cursorPos,
			wordStart: cursorPos - prefix.length,
		};
	}

	private isInCodeContext(state: EditorState, pos: number): boolean {
		try {
			const tree = syntaxTree(state);
			for (let node: any = tree.resolveInner(Math.max(0, pos - 1), -1); node; node = node.parent) {
				if (this.isCodeNodeName(node.name)) {
					return true;
				}
			}
		} catch (error) {
			console.debug("Txt Autocomplete: syntax-tree lookup failed", error);
		}

		return this.isInCodeContextFallback(state, pos);
	}

	private isCodeNodeName(name: string): boolean {
		return (
			name === "InlineCode" ||
			name === "CodeText" ||
			name === "CodeMark" ||
			name === "CodeBlock" ||
			name === "FencedCode" ||
			name.includes("Code")
		);
	}

	private isInCodeContextFallback(state: EditorState, pos: number): boolean {
		const line = state.doc.lineAt(pos);
		const beforeCursor = line.text.slice(0, pos - line.from);

		if (this.isInsideInlineCode(beforeCursor)) {
			return true;
		}

		const startLine = Math.max(1, line.number - 200);
		let openFence: { marker: "`" | "~"; length: number } | null = null;

		for (let lineNumber = startLine; lineNumber <= line.number; lineNumber++) {
			const text = state.doc.line(lineNumber).text;
			const match = text.match(/^\s*(`{3,}|~{3,})/u);
			if (!match) continue;

			const token = match[1];
			const marker = token[0] as "`" | "~";
			const length = token.length;

			if (!openFence) {
				openFence = { marker, length };
				continue;
			}

			if (openFence.marker === marker && length >= openFence.length) {
				openFence = null;
			}
		}

		return openFence !== null;
	}

	private isInsideInlineCode(text: string): boolean {
		let index = 0;
		let openTicks = 0;

		while (index < text.length) {
			if (text[index] !== "`") {
				index++;
				continue;
			}

			let runEnd = index;
			while (runEnd < text.length && text[runEnd] === "`") {
				runEnd++;
			}

			const runLength = runEnd - index;

			if (openTicks === 0) {
				openTicks = runLength;
			} else if (openTicks === runLength) {
				openTicks = 0;
			}

			index = runEnd;
		}

		return openTicks !== 0;
	}

	private shouldAppendSpace(view: EditorView, insertTo: number): boolean {
		if (!this.settings.addSpace) return false;

		const nextChar = view.state.doc.sliceString(insertTo, insertTo + 1);
		return nextChar === "" || !/^[-\s\]\)\}\.,;:!?'"`|\/]/u.test(nextChar);
	}

	private matchCase(word: string, original: string): string {
		if (!original) return word;

		if (original === original.toUpperCase()) {
			return word.toUpperCase();
		}

		if (original === original.toLowerCase()) {
			return word.toLowerCase();
		}

		const first = original.charAt(0);
		const rest = original.slice(1);

		if (
			first === first.toUpperCase() &&
			rest === rest.toLowerCase()
		) {
			return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
		}

		return word;
	}

	private getGhostSession(view: EditorView): import("./types").GhostTextSession | null {
		return view.state.field(GhostTextState, false) ?? null;
	}

	private hasActiveSuggestion(view: EditorView, requireMultiple = false): boolean {
		const session = this.getGhostSession(view);
		if (!session) return false;
		if (requireMultiple && session.suggestions.length < 2) return false;

		const selection = view.state.selection.main;
		return selection.empty && selection.head === session.cursorPos;
	}

	private getEditorView(markdownView: MarkdownView | null | undefined): EditorView | null {
		if (!markdownView) return null;

		const editorWithCm = markdownView.editor as Editor & { cm?: EditorView };
		return editorWithCm.cm ?? null;
	}
}