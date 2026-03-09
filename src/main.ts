import {
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	normalizePath,
	type App,
	type Editor,
	MarkdownView,
} from "obsidian";
import { syntaxTree } from "@codemirror/language";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	keymap,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import {
	Prec,
	StateEffect,
	StateField,
	type EditorState,
	type Extension,
} from "@codemirror/state";

/* ============================================================================
   Types
   ============================================================================ */

interface PluginSettings {
	enabled: boolean;
	maxSuggestions: number;
	minLength: number;
	addSpace: boolean;
	enableInCode: boolean;
	fuzzyEdits: number;
	fuzzyMinLength: number;
}

interface SuggestionItem {
	text: string;
	isFuzzy: boolean;
	wordStart: number;
}

interface GhostTextSession {
	suggestions: SuggestionItem[];
	currentIndex: number;
	cursorPos: number;
}

interface WordContext {
	prefix: string;
	cursorPos: number;
	wordStart: number;
}

interface FuzzyResult {
	word: string;
	dist: number;
}

/* ============================================================================
   Trie
   ============================================================================ */

class TrieNode {
	public readonly children = new Map<string, TrieNode>();
	public word: string | null = null;
}

class Trie {
	private readonly root = new TrieNode();

	public insert(word: string): void {
		const original = word.trim();
		if (!original) return;

		let node = this.root;
		for (const ch of original.toLowerCase()) {
			let next = node.children.get(ch);
			if (!next) {
				next = new TrieNode();
				node.children.set(ch, next);
			}
			node = next;
		}

		if (node.word === null) {
			node.word = original;
		}
	}

	public search(prefix: string, limit = 5): string[] {
		if (!prefix || limit <= 0) return [];

		let node = this.root;
		for (const ch of prefix.toLowerCase()) {
			const next = node.children.get(ch);
			if (!next) return [];
			node = next;
		}

		const results: string[] = [];
		this.collect(node, results, limit);
		return results;
	}

	public searchFuzzy(term: string, maxEdits: number, limit = 5): FuzzyResult[] {
		if (!term || maxEdits <= 0 || limit <= 0) return [];

		const query = term.toLowerCase();
		const firstRow = Array.from({ length: query.length + 1 }, (_, index) => index);
		const results: FuzzyResult[] = [];

		this.fuzzyDfs(
			this.root,
			"",
			"",
			query,
			firstRow,
			null,
			maxEdits,
			results,
			limit,
		);

		results.sort((a, b) => a.dist - b.dist || a.word.localeCompare(b.word));
		return results.slice(0, limit);
	}

	private collect(node: TrieNode, results: string[], limit: number): void {
		if (results.length >= limit) return;

		if (node.word !== null) {
			results.push(node.word);
		}

		for (const child of node.children.values()) {
			if (results.length >= limit) break;
			this.collect(child, results, limit);
		}
	}

	private fuzzyDfs(
		node: TrieNode,
		prefix: string,
		prevChar: string,
		query: string,
		prevRow: number[],
		prevPrevRow: number[] | null,
		maxEdits: number,
		results: FuzzyResult[],
		limit: number,
	): void {
		for (const [ch, child] of node.children) {
			const currRow = [prevRow[0] + 1];
			let rowMin = currRow[0];

			for (let j = 1; j < prevRow.length; j++) {
				const cost = query[j - 1] === ch ? 0 : 1;

				let value = Math.min(
					currRow[j - 1] + 1,
					prevRow[j] + 1,
					prevRow[j - 1] + cost,
				);

				if (
					prevPrevRow &&
					j > 1 &&
					ch === query[j - 2] &&
					prevChar === query[j - 1]
				) {
					value = Math.min(value, prevPrevRow[j - 2] + 1);
				}

				currRow[j] = value;
				if (value < rowMin) rowMin = value;
			}

			const newPrefix = prefix + ch;
			const dist = currRow[currRow.length - 1];

			if (child.word !== null && dist <= maxEdits) {
				results.push({ word: child.word, dist });

				if (results.length > limit * 5) {
					results.sort((a, b) => a.dist - b.dist || a.word.localeCompare(b.word));
					results.length = limit * 3;
				}
			}

			if (rowMin <= maxEdits) {
				this.fuzzyDfs(
					child,
					newPrefix,
					ch,
					query,
					currRow,
					prevRow,
					maxEdits,
					results,
					limit,
				);
			}
		}
	}
}

/* ============================================================================
   Settings
   ============================================================================ */

const DEFAULT_SETTINGS: PluginSettings = {
	enabled: true,
	maxSuggestions: 5,
	minLength: 3,
	addSpace: true,
	enableInCode: false,
	fuzzyEdits: 2,
	fuzzyMinLength: 4,
};

/* ============================================================================
   Effects & State
   ============================================================================ */

const SetSuggestionsEffect = StateEffect.define<GhostTextSession>();
const CycleSuggestionEffect = StateEffect.define<1 | -1>();
const ClearSuggestionsEffect = StateEffect.define<null>();

const GhostTextState = StateField.define<GhostTextSession | null>({
	create: () => null,

	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(SetSuggestionsEffect)) return effect.value;
			if (effect.is(ClearSuggestionsEffect)) return null;

			if (
				effect.is(CycleSuggestionEffect) &&
				value?.suggestions.length &&
				value.suggestions.length > 1
			) {
				const length = value.suggestions.length;
				const nextIndex =
					(value.currentIndex + effect.value + length) % length;

				return { ...value, currentIndex: nextIndex };
			}
		}

		if (!value) return null;

		if (tr.docChanged && value) {
			let touched = false;

			tr.changes.iterChanges((fromA, toA) => {
				if (fromA <= value!.cursorPos && value!.cursorPos <= toA) {
					touched = true;
				}
			});

			if (!touched) {
				const activeSuggestion = value.suggestions[value.currentIndex];
				if (activeSuggestion?.isFuzzy) {
					const from = activeSuggestion.wordStart;
					const to = value.cursorPos;

					tr.changes.iterChanges((fromA, toA) => {
						const overlaps = !(toA < from || fromA > to);
						if (overlaps) touched = true;
					});
				}
			}

			if (touched) return null;

			const mappedCursor = tr.changes.mapPos(value.cursorPos, 1);
			const mappedSuggestions = value.suggestions.map((suggestion) =>
				suggestion.isFuzzy
					? {
							...suggestion,
							wordStart: tr.changes.mapPos(suggestion.wordStart, -1),
						}
					: suggestion,
			);

			value = {
				...value,
				cursorPos: mappedCursor,
				suggestions: mappedSuggestions,
			};
		}

		if (
			tr.selection &&
			(
				tr.state.selection.ranges.length > 1 ||
				!tr.state.selection.main.empty ||
				tr.state.selection.main.head !== value.cursorPos
			)
		) {
			return null;
		}

		return value;
	},
});

/* ============================================================================
   Widget & Decorations
   ============================================================================ */

class GhostTextWidget extends WidgetType {
	public constructor(
		private readonly text: string,
		private readonly isFuzzy: boolean,
	) {
		super();
	}

	public override eq(other: GhostTextWidget): boolean {
		return other.text === this.text && other.isFuzzy === this.isFuzzy;
	}

	public override toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.className = this.isFuzzy
			? "txt-autocomplete-ghost-text txt-autocomplete-ghost-fuzzy"
			: "txt-autocomplete-ghost-text";

		if (this.isFuzzy) {
			const arrow = document.createElement("span");
			arrow.className = "txt-autocomplete-ghost-arrow";
			arrow.textContent = "→";
			span.append(arrow, document.createTextNode(this.text));
		} else {
			span.textContent = this.text;
		}

		return span;
	}

	public override ignoreEvent(): boolean {
		return true;
	}
}

const GhostTextPlugin = Prec.lowest(
	ViewPlugin.fromClass(
		class {
			public decorations: DecorationSet = Decoration.none;

			public update(update: ViewUpdate): void {
				const session = update.state.field(GhostTextState, false);
				if (!session?.suggestions.length) {
					this.decorations = Decoration.none;
					return;
				}

				const suggestion = session.suggestions[session.currentIndex];
				if (!suggestion) {
					this.decorations = Decoration.none;
					return;
				}

				const widget = Decoration.widget({
					widget: new GhostTextWidget(suggestion.text, suggestion.isFuzzy),
					side: 1,
				});

				this.decorations = Decoration.set([
					widget.range(session.cursorPos),
				]);
			}
		},
		{
			decorations: (value) => value.decorations,
		},
	),
);

/* ============================================================================
   Keymap
   ============================================================================ */

const createEditorKeymap = (plugin: TextAutocompletePlugin): Extension =>
	Prec.high(
		keymap.of([
			{
				key: "Tab",
				run: (view) => plugin.acceptSuggestion(view),
			},
			{
				key: "ArrowRight",
				run: (view) => plugin.cycleSuggestion(view, 1),
			},
			{
				key: "ArrowLeft",
				run: (view) => plugin.cycleSuggestion(view, -1),
			},
			{
				key: "Escape",
				run: (view) => plugin.dismissSuggestions(view),
			},
		]),
	);

/* ============================================================================
   Change Listener
   ============================================================================ */

const createChangeListener = (plugin: TextAutocompletePlugin): Extension =>
	ViewPlugin.fromClass(
		class {
			private timeout: number | null = null;

			public constructor(private readonly view: EditorView) {}

			public update(update: ViewUpdate): void {
				if (!plugin.settings.enabled) return;
				if (!update.view.hasFocus) return;
				if (!update.docChanged) return;

				const isRelevantEdit = update.transactions.some(
					(tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"),
				);

				if (!isRelevantEdit) return;

				if (this.timeout !== null) {
					window.clearTimeout(this.timeout);
				}

				this.timeout = window.setTimeout(() => {
					this.timeout = null;
					plugin.refreshSuggestionsAtCursor(this.view);
				}, 60);
			}

			public destroy(): void {
				if (this.timeout !== null) {
					window.clearTimeout(this.timeout);
				}
			}
		},
	);

/* ============================================================================
   Main Plugin
   ============================================================================ */

export default class TextAutocompletePlugin extends Plugin {
	public settings: PluginSettings = DEFAULT_SETTINGS;

	private trie = new Trie();
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
		this.settings = {
			...DEFAULT_SETTINGS,
			...(await this.loadData()),
		};
	}

	public async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
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

		if (/^[\p{L}\p{N}'’-]/u.test(after)) return null;

		const match = before.match(/[\p{L}][\p{L}\p{N}'’-]*$/u);
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
		return nextChar === "" || !/^[\s\]\)\}\.,;:!?'"`|\/]/u.test(nextChar);
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

	private getGhostSession(view: EditorView): GhostTextSession | null {
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

/* ============================================================================
   Settings Tab
   ============================================================================ */

class AutocompleteSettingTab extends PluginSettingTab {
	public constructor(app: App, private readonly plugin: TextAutocompletePlugin) {
		super(app, plugin);
	}

	private async updateSetting<K extends keyof PluginSettings>(key: K, value: PluginSettings[K]): Promise<void> {
		this.plugin.settings[key] = value;
		await this.plugin.saveSettings();
		this.plugin.clearAllEditors();
	}

	public override display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Txt Autocomplete" });
		containerEl.createEl("p", {
			text: "Tab accepts, Left/Right cycles, Esc dismisses. Commands are also available in Hotkeys.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Enable autocomplete")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enabled)
					.onChange((value) => this.updateSetting("enabled", value)),
			);

		new Setting(containerEl)
			.setName("Max suggestions")
			.setDesc("How many suggestions to keep in the rotation.")
			.addSlider((slider) =>
				slider
					.setLimits(3, 10, 1)
					.setValue(this.plugin.settings.maxSuggestions)
					.setDynamicTooltip()
					.onChange((value) => this.updateSetting("maxSuggestions", value)),
			);

		new Setting(containerEl)
			.setName("Minimum word length")
			.setDesc("Characters required before suggestions appear.")
			.addSlider((slider) =>
				slider
					.setLimits(2, 6, 1)
					.setValue(this.plugin.settings.minLength)
					.setDynamicTooltip()
					.onChange((value) => this.updateSetting("minLength", value)),
			);

		new Setting(containerEl)
			.setName("Fuzzy edit distance")
			.setDesc("Maximum edits allowed for fuzzy matches. Set to 0 to disable fuzzy matching.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 3, 1)
					.setValue(this.plugin.settings.fuzzyEdits)
					.setDynamicTooltip()
					.onChange((value) => this.updateSetting("fuzzyEdits", value)),
			);

		new Setting(containerEl)
			.setName("Minimum length for fuzzy matching")
			.setDesc("Avoid expensive fuzzy matching on very short prefixes.")
			.addSlider((slider) =>
				slider
					.setLimits(3, 8, 1)
					.setValue(this.plugin.settings.fuzzyMinLength)
					.setDynamicTooltip()
					.onChange((value) => this.updateSetting("fuzzyMinLength", value)),
			);

		new Setting(containerEl)
			.setName("Add trailing space")
			.setDesc("Append a space after accepting a completion when punctuation does not follow.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.addSpace)
					.onChange((value) => this.updateSetting("addSpace", value)),
			);

		new Setting(containerEl)
			.setName("Enable inside code")
			.setDesc("Show suggestions inside fenced code blocks and inline code.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableInCode)
					.onChange((value) => this.updateSetting("enableInCode", value)),
			);

		new Setting(containerEl)
			.setName("Reload dictionary")
			.setDesc(this.plugin.getDictionaryPath())
			.addButton((button) =>
				button
					.setButtonText("Reload")
					.setCta()
					.onClick(async () => {
						await this.plugin.reloadDictionary(true);
					}),
			);
	}
}