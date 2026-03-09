# Txt Autocomplete

Ghost-text word autocomplete for Obsidian.

Txt Autocomplete suggests word completions as you type and shows them inline in the editor. It supports fast prefix matching, fuzzy matching for small typos, case-aware insertion, and optional blocking inside code.

## What it does

Txt Autocomplete is a local dictionary-based autocomplete plugin.

It provides:

- inline ghost-text suggestions
- prefix matching through a trie
- fuzzy matching with configurable edit distance
- case-aware completions
- optional exclusion inside inline code and fenced code blocks
- keyboard commands and hotkey support

It does not currently learn from your notes or show a dropdown menu.

## Features

- Fast prefix autocomplete
- Fuzzy matching for near-miss words
- Ghost-text preview directly in the editor
- Tab to accept suggestions
- Left and Right arrow keys to cycle suggestions
- Escape to dismiss suggestions
- Hotkey-bindable commands through Obsidian
- Custom dictionary file in `words.txt`

## Installation

### Manual install

Copy these files into:

`.obsidian/plugins/txt-autocomplete/`

Required files:

- `main.js`
- `manifest.json`
- `styles.css`
- `words.txt`

Then restart Obsidian and enable **Txt Autocomplete** in Community Plugins.

## Usage

Start typing a word in a note.

When a suggestion is available, it appears as ghost text after the cursor.

Default controls:

- `Tab` accepts the current suggestion
- `ArrowRight` moves to the next suggestion
- `ArrowLeft` moves to the previous suggestion
- `Escape` dismisses suggestions

The same actions are also exposed as Obsidian commands, so you can rebind them in **Settings → Hotkeys**.

## Settings

### Enable autocomplete
Turns the plugin on or off.

### Max suggestions
Controls how many suggestions are kept in rotation.

### Minimum word length
Sets how many typed characters are required before suggestions appear.

### Fuzzy edit distance
Controls how many edits are allowed for fuzzy matching. Set it to `0` to disable fuzzy matching.

### Minimum length for fuzzy matching
Prevents fuzzy matching from running on very short prefixes.

### Add trailing space
Adds a space after accepting a completion unless punctuation or closing characters already follow.

### Enable inside code
Allows suggestions inside fenced code blocks and inline code.

## Dictionary

The plugin reads words from:

`.obsidian/plugins/txt-autocomplete/words.txt`

Put one word per line.

Example:

```txt
apple
application
applied
banana
because
beautiful