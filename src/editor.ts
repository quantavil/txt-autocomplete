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
	type Extension,
} from "@codemirror/state";
import type { GhostTextSession } from "./types";
import type TextAutocompletePlugin from "./main";

export const SetSuggestionsEffect = StateEffect.define<GhostTextSession>();
export const CycleSuggestionEffect = StateEffect.define<1 | -1>();
export const ClearSuggestionsEffect = StateEffect.define<null>();

export const GhostTextState = StateField.define<GhostTextSession | null>({
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

export class GhostTextWidget extends WidgetType {
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

export const GhostTextPlugin = Prec.lowest(
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

export const createEditorKeymap = (plugin: TextAutocompletePlugin): Extension =>
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

export const createChangeListener = (plugin: TextAutocompletePlugin): Extension =>
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
