import { Notice, type TFile } from "obsidian";
import type TextAutocompletePlugin from "./main";

const WORD_RE = /(?<!\p{L})\p{L}(?:[-\p{L}'’]*\p{L})?(?!\p{L})/gu;

export async function scanVault(plugin: TextAutocompletePlugin): Promise<void> {
	if (!plugin.settings.enableVaultLearning) {
		new Notice("Vault learning is disabled in settings.");
		return;
	}

	new Notice("Scanning vault for words... This may take a moment.");

	const files = plugin.app.vault.getMarkdownFiles();
	const counts = new Map<string, number>();

	for (const file of files) {
		const content = await plugin.app.vault.read(file);
		const matches = content.match(WORD_RE);

		if (!matches) continue;

		for (const match of matches) {
			const lower = match.toLowerCase();
			const count = counts.get(lower) ?? 0;
			counts.set(lower, count + 1);
		}
	}

	const pluginUserWords = plugin.data.userWords || [];
	const pluginIgnoredWords = plugin.data.ignoredWords || [];
	let addedCount = 0;

	for (const [word, count] of counts.entries()) {
		if (count < plugin.settings.learnedMinOccurrences) continue;
		if (word.length < plugin.settings.learnedMinLength) continue;

		if (pluginIgnoredWords.includes(word)) continue;
		if (pluginUserWords.includes(word)) continue;
		if (plugin.trie.has(word)) continue;

		pluginUserWords.push(word);
		addedCount++;
	}

	if (addedCount > 0) {
		pluginUserWords.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
		plugin.data.userWords = pluginUserWords;
		await plugin.saveWords();
		await plugin.reloadDictionary(false);

		new Notice(`Scan complete. Added ${addedCount} new words to your user dictionary.`);
	} else {
		new Notice("Scan complete. No new words found.");
	}
}
