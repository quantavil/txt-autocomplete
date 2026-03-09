import { PluginSettingTab, Setting, type App, Notice, setIcon } from "obsidian";
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

	private addSliderSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		key: keyof PluginSettings,
		min: number,
		max: number,
		step: number,
	): void {
		const setting = new Setting(containerEl)
			.setName(name)
			.setDesc(desc);

		const valueEl = setting.settingEl.createEl("span", {
			text: String(this.plugin.settings[key]),
			cls: "txt-autocomplete-slider-value-label",
		});

		setting.addSlider((slider) => {
			slider
				.setLimits(min, max, step)
				.setValue(this.plugin.settings[key] as number)
				.setDynamicTooltip()
				.onChange((value) => {
					void this.updateSetting(key, value);
					valueEl.setText(String(value));
				});
		});
	}

	public override display(): void {
		const { containerEl } = this;
		
		// Save scroll positions
		const mainScroll = containerEl.scrollTop;
		const userListScroll = containerEl.querySelector(".txt-user-words-list")?.scrollTop || 0;
		const ignoreListScroll = containerEl.querySelector(".txt-ignored-words-list")?.scrollTop || 0;

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

		this.addSliderSetting(
			containerEl,
			"Max suggestions",
			"How many suggestions to keep in the rotation.",
			"maxSuggestions",
			3, 10, 1
		);

		this.addSliderSetting(
			containerEl,
			"Minimum word length",
			"Characters required before suggestions appear.",
			"minLength",
			2, 6, 1
		);

		this.addSliderSetting(
			containerEl,
			"Fuzzy edit distance",
			"Maximum edits allowed for fuzzy matches. Set to 0 to disable fuzzy matching.",
			"fuzzyEdits",
			0, 3, 1
		);

		this.addSliderSetting(
			containerEl,
			"Minimum length for fuzzy matching",
			"Avoid expensive fuzzy matching on very short prefixes.",
			"fuzzyMinLength",
			3, 8, 1
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

		this.addSliderSetting(
			containerEl,
			"Minimum learned length",
			"Ignore words shorter than this when scanning.",
			"learnedMinLength",
			3, 8, 1
		);

		this.addSliderSetting(
			containerEl,
			"Minimum occurrences",
			"Require a word to appear this many times across your vault before adding it.",
			"learnedMinOccurrences",
			1, 10, 1
		);

        let newWordInput = "";
        new Setting(containerEl)
            .setName("Add word")
            .setDesc("Add a new word to your User Dictionary.")
            .addText((text) =>
                text
                    .setPlaceholder("New word")
                    .onChange((value) => {
                        newWordInput = value;
                    })
            )
            .addButton((button) =>
                button
                    .setIcon("plus")
                    .setTooltip("Add to dictionary")
                    .onClick(async () => {
                        const word = newWordInput.trim().toLowerCase();
                        if (!word) return;

                        this.plugin.data.userWords = this.plugin.data.userWords || [];
                        if (!this.plugin.data.userWords.includes(word)) {
                            this.plugin.data.userWords.push(word);
                            this.plugin.data.userWords.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
                            
                            // Remove from ignore list if it was there
                            if (this.plugin.data.ignoredWords?.includes(word)) {
                                this.plugin.data.ignoredWords = this.plugin.data.ignoredWords.filter(w => w !== word);
                            }

                            await this.plugin.saveWords();
                            await this.plugin.reloadDictionary(false);
                            new Notice(`Added '${word}' to user dictionary.`);
                            this.display();
                        } else {
                            new Notice(`'${word}' is already in your user dictionary.`);
                        }
                    })
            );

        const dualPane = containerEl.createEl("div", { cls: "txt-autocomplete-dual-pane" });

        // --- User Dictionary Pane ---
        const userPane = dualPane.createEl("div", { cls: "txt-autocomplete-word-pane" });
        userPane.createEl("h3", { text: "User Dictionary" });

        const userWords = this.plugin.data.userWords || [];
        const userList = userPane.createEl("div", { cls: "txt-autocomplete-word-list txt-user-words-list" });
        if (userWords.length === 0) {
            userList.createEl("div", { text: "No words added.", cls: "txt-autocomplete-word-item" });
        } else {
            for (const word of userWords) {
                const item = userList.createEl("div", { cls: "txt-autocomplete-word-item" });
                item.createEl("span", { text: word });

                const btnRemove = item.createEl("div", { cls: "clickable-icon is-warning" });
                setIcon(btnRemove, "trash");
                btnRemove.setAttribute("aria-label", "Delete and Ignore");
                
                btnRemove.onclick = async () => {
                    this.plugin.data.userWords = this.plugin.data.userWords?.filter(w => w !== word);
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
        }

        if (userWords.length > 0) {
            new Setting(userPane)
                .setName("Clear all")
                .addButton((button) =>
                    button
                        .setButtonText("Clear All")
                        .setWarning()
                        .onClick(async () => {
                            if (confirm("Delete all words in User Dictionary?")) {
                                this.plugin.data.userWords = [];
                                await this.plugin.saveWords();
                                await this.plugin.reloadDictionary(false);
                                new Notice("User dictionary cleared.");
                                this.display();
                            }
                        })
                );
        }

        // --- Ignore List Pane ---
        const ignorePane = dualPane.createEl("div", { cls: "txt-autocomplete-word-pane" });
        ignorePane.createEl("h3", { text: "Ignore List" });
        
        const ignoredWords = this.plugin.data.ignoredWords || [];
        const ignoreList = ignorePane.createEl("div", { cls: "txt-autocomplete-word-list txt-ignored-words-list" });
        if (ignoredWords.length === 0) {
            ignoreList.createEl("div", { text: "No ignored words.", cls: "txt-autocomplete-word-item" });
        } else {
            for (const word of ignoredWords) {
                const item = ignoreList.createEl("div", { cls: "txt-autocomplete-word-item" });
                item.createEl("span", { text: word });

                const btnRestore = item.createEl("div", { cls: "clickable-icon" });
                setIcon(btnRestore, "undo");
                btnRestore.setAttribute("aria-label", "Unignore");

                btnRestore.onclick = async () => {
                    this.plugin.data.ignoredWords = this.plugin.data.ignoredWords?.filter(w => w !== word);
                    await this.plugin.saveWords();
                    await this.plugin.reloadDictionary(false);
                    new Notice(`Unignored '${word}'.`);
                    this.display();
                };
            }
        }

        if (ignoredWords.length > 0) {
            new Setting(ignorePane)
                .setName("Clear all")
                .addButton((button) =>
                    button
                        .setButtonText("Clear All")
                        .setWarning()
                        .onClick(async () => {
                            if (confirm("Clear the entire Ignore List?")) {
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

		// Restore scroll positions
		containerEl.scrollTop = mainScroll;
		const newUserList = containerEl.querySelector(".txt-user-words-list");
		if (newUserList) newUserList.scrollTop = userListScroll;
		const newIgnoreList = containerEl.querySelector(".txt-ignored-words-list");
		if (newIgnoreList) newIgnoreList.scrollTop = ignoreListScroll;
	}
}
