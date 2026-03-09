export interface PluginSettings {
	enabled: boolean;
	maxSuggestions: number;
	minLength: number;
	addSpace: boolean;
	enableInCode: boolean;
	fuzzyEdits: number;
	fuzzyMinLength: number;
	enableVaultLearning: boolean;
	learnedMinLength: number;
	learnedMinOccurrences: number;
}

export interface SavedData {
	settings?: Partial<PluginSettings>;
	userWords?: string[];
	ignoredWords?: string[];
}

export interface SuggestionItem {
	text: string;
	isFuzzy: boolean;
	wordStart: number;
}

export interface GhostTextSession {
	suggestions: SuggestionItem[];
	currentIndex: number;
	cursorPos: number;
}

export interface WordContext {
	prefix: string;
	cursorPos: number;
	wordStart: number;
}

export interface FuzzyResult {
	word: string;
	dist: number;
}
