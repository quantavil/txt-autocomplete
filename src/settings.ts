import { PluginSettingTab, Setting, type App, Notice } from "obsidian";
import type { PluginSettings } from "./types";
import type TextAutocompletePlugin from "./main";
import { scanVault } from "./scanner";

export const DEFAULT_SETTINGS: PluginSettings = {
	enabled: true,
	maxSuggestions: 5,
	minLength: 3,
	addSpace: true,
	enableInCode: false,
	fuzzyEdits: 2,
	fuzzyMinLength: 4,
	enableVaultLearning: false,
	learnedMinLength: 4,
	learnedMinOccurrences: 3,
};

export class AutocompleteSettingTab extends PluginSettingTab {
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

        containerEl.createEl("h3", { text: "Autocomplete" });
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

        containerEl.createEl("h3", { text: "Learning (Vault Scan)" });

		new Setting(containerEl)
			.setName("Enable vault scanning")
			.setDesc("Allow the plugin to scan your vault to learn new words.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableVaultLearning)
					.onChange((value) => this.updateSetting("enableVaultLearning", value)),
			);

		new Setting(containerEl)
			.setName("Minimum learned length")
			.setDesc("Ignore words shorter than this when scanning.")
			.addSlider((slider) =>
				slider
					.setLimits(3, 8, 1)
					.setValue(this.plugin.settings.learnedMinLength)
					.setDynamicTooltip()
					.onChange((value) => this.updateSetting("learnedMinLength", value)),
			);

		new Setting(containerEl)
			.setName("Minimum occurrences")
			.setDesc("Require a word to appear this many times across your vault before adding it.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.learnedMinOccurrences)
					.setDynamicTooltip()
					.onChange((value) => this.updateSetting("learnedMinOccurrences", value)),
			);

        containerEl.createEl("h3", { text: "User Dictionary" });
		
		let newWordInput = "";
		new Setting(containerEl)
			.setName("Add word manually")
			.setDesc("Add a specific word to your user dictionary.")
			.addText((text) =>
				text
					.setPlaceholder("New word")
					.onChange((value) => {
						newWordInput = value;
					})
			)
			.addButton((button) =>
				button
					.setButtonText("Add")
					.setCta()
					.onClick(async () => {
						const word = newWordInput.trim().toLowerCase();
						if (!word) return;

						this.plugin.data.userWords = this.plugin.data.userWords || [];
						if (!this.plugin.data.userWords.includes(word)) {
							this.plugin.data.userWords.push(word);
							this.plugin.data.userWords.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
							await this.plugin.saveWords();
                            await this.plugin.reloadDictionary(false);
							new Notice(`Added '${word}' to user dictionary.`);
							this.display(); // Refresh UI
						} else {
							new Notice(`'${word}' is already in your user dictionary.`);
						}
					})
			);

		const userWords = this.plugin.data.userWords || [];
		if (userWords.length > 0) {
			const details = containerEl.createEl("details");
			details.createEl("summary", { text: `View all user words (${userWords.length})` });
			
			const list = details.createEl("div", { cls: "txt-autocomplete-word-list" });
			for (const word of userWords) {
				const item = list.createEl("div", { cls: "txt-autocomplete-word-item" });
				item.style.display = "flex";
				item.style.justifyContent = "space-between";
				item.style.alignItems = "center";
				item.style.marginBottom = "4px";

				item.createEl("span", { text: word });

				const btns = item.createEl("div");
				const btnRemove = btns.createEl("button", { text: "Delete" });
				btnRemove.onclick = async () => {
					this.plugin.data.userWords = this.plugin.data.userWords?.filter(w => w !== word);
					
					// User proposed: Delete = remove from user words + add to ignore list
					this.plugin.data.ignoredWords = this.plugin.data.ignoredWords || [];
					if (!this.plugin.data.ignoredWords.includes(word)) {
						this.plugin.data.ignoredWords.push(word);
						this.plugin.data.ignoredWords.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
					}

					await this.plugin.saveWords();
                    await this.plugin.reloadDictionary(false);
					new Notice(`Deleted and ignored '${word}'.`);
					this.display();
				};
			}

            new Setting(containerEl)
                .setName("Clear all user words")
                .setDesc("Remove all manually added and scanning-learned words from the User Dictionary. This does not add them to the Ignore List.")
                .addButton((button) =>
                    button
                        .setButtonText("Clear All")
                        .setWarning()
                        .onClick(async () => {
                            if (confirm("Are you sure you want to delete all words in your User Dictionary?")) {
                                this.plugin.data.userWords = [];
                                await this.plugin.saveWords();
                                await this.plugin.reloadDictionary(false);
                                new Notice("All user words cleared.");
                                this.display();
                            }
                        })
                );
		}

        containerEl.createEl("h3", { text: "Ignore List" });
		containerEl.createEl("p", {
			text: "Ignored words will never be suggested and won't be re-added when scanning the vault.",
			cls: "setting-item-description",
		});

		const ignoredWords = this.plugin.data.ignoredWords || [];
		if (ignoredWords.length > 0) {
			const details = containerEl.createEl("details");
			details.createEl("summary", { text: `View ignored words (${ignoredWords.length})` });
			
			const list = details.createEl("div", { cls: "txt-autocomplete-word-list" });
			for (const word of ignoredWords) {
				const item = list.createEl("div", { cls: "txt-autocomplete-word-item" });
				item.style.display = "flex";
				item.style.justifyContent = "space-between";
				item.style.alignItems = "center";
				item.style.marginBottom = "4px";

				item.createEl("span", { text: word });

				const btns = item.createEl("div");
				const btnUnignore = btns.createEl("button", { text: "Unignore" });
				btnUnignore.onclick = async () => {
					this.plugin.data.ignoredWords = this.plugin.data.ignoredWords?.filter(w => w !== word);
					await this.plugin.saveWords();
                    await this.plugin.reloadDictionary(false);
					new Notice(`Unignored '${word}'.`);
					this.display();
				};
			}

            new Setting(containerEl)
                .setName("Clear all ignored words")
                .setDesc("Remove all words from the Ignore List. They may be re-learned during future scans.")
                .addButton((button) =>
                    button
                        .setButtonText("Clear All")
                        .setWarning()
                        .onClick(async () => {
                            if (confirm("Are you sure you want to clear the entire Ignore List?")) {
                                this.plugin.data.ignoredWords = [];
                                await this.plugin.saveWords();
                                await this.plugin.reloadDictionary(false);
                                new Notice("Ignore List cleared.");
                                this.display();
                            }
                        })
                );
		}

        containerEl.createEl("h3", { text: "Actions" });

		new Setting(containerEl)
			.setName("Scan vault")
			.setDesc("Manually trigger a vault scan to learn new words.")
			.addButton((button) =>
				button
					.setButtonText("Scan Now")
					.setCta()
					.onClick(async () => {
						try {
                            button.setButtonText("Scanning...");
							button.setDisabled(true);
							await scanVault(this.plugin);
							this.display();
						} finally {
							button.setButtonText("Scan Now");
							button.setDisabled(false);
						}
					})
			);

		new Setting(containerEl)
			.setName("Reload dictionary")
			.setDesc(`Reload the words trie from ${this.plugin.getDictionaryPath()} and User Dictionary.`)
			.addButton((button) =>
				button
					.setButtonText("Reload")
					.onClick(async () => {
						await this.plugin.reloadDictionary(true);
                        new Notice("Dictionary reloaded");
					}),
			);
	}
}
