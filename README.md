# Txt Autocomplete

Intelligent text autocomplete with context awareness and learning capabilities for Obsidian.

## Description

Txt Autocomplete is an Obsidian plugin that provides intelligent text autocompletion as you type. It uses a Trie data structure for efficient word suggestions and supports fuzzy matching to help you find the right words even with typos or partial matches.

## Features

- **Fast Autocomplete**: Uses optimized Trie data structure for lightning-fast suggestions
- **Fuzzy Matching**: Finds words even with typos using Damerau-Levenshtein distance algorithm
- **Context Awareness**: Automatically detects code blocks and adjusts suggestions accordingly
- **Customizable Settings**: Configure suggestion limits, minimum word length, and more
- **Learning Dictionary**: Includes a comprehensive English word dictionary
- **Case Matching**: Preserves case patterns from your input

## Installation

1. Download the plugin files
2. Copy the plugin folder to your Obsidian vault's `.obsidian/plugins/` directory
3. Reload Obsidian
4. Enable the plugin in Settings > Community Plugins

### Manual Installation

1. Clone or download this repository
2. Copy the `txt-autocomplete` folder to your vault's `.obsidian/plugins/` directory
3. Ensure the folder structure is: `.obsidian/plugins/txt-autocomplete/`
4. Restart Obsidian
5. Go to Settings > Community Plugins and enable "Txt Autocomplete"

## Usage

Simply start typing in any note. The plugin will automatically suggest completions based on your input.

- Type at least 3 characters (configurable) to trigger suggestions
- Use arrow keys to navigate suggestions
- Press Enter or Tab to accept a suggestion
- Press Escape to dismiss suggestions

### Settings

Access plugin settings through Settings > Plugin Options > Text Autocomplete:

- **Enable autocomplete**: Toggle the plugin on/off
- **Max suggestions**: Number of suggestions to show (3-10)
- **Min word length**: Minimum characters before triggering (2-5)
- **Add space after word**: Automatically add space after completion
- **Enable in code blocks**: Allow suggestions in code blocks and inline code

## How It Works

The plugin uses a Trie (prefix tree) data structure loaded with a comprehensive English dictionary. When you type, it:

1. Monitors your input for word boundaries
2. Searches the Trie for exact prefix matches
3. Falls back to fuzzy matching if exact matches are insufficient
4. Ranks suggestions by relevance and presents them in a dropdown

## Performance

- Optimized for large dictionaries
- Minimal memory footprint
- Fast search algorithms ensure no lag in typing

## Compatibility

- Requires Obsidian v0.15.0 or higher
- Works on desktop only (as per manifest configuration)

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Future Features (Priority Order - Quick Wins)

1. **Improved Fuzzy Matching**
   - Add more sophisticated fuzzy algorithms
   - Configurable edit distance limits
   - Better ranking for fuzzy matches

2. **Context-Aware Suggestions**
   - Learn from user's writing patterns
   - Suggest based on current note's vocabulary
   - Topic-specific suggestions

3. **UI Enhancements**
   - Better suggestion display styling
   - Keyboard shortcut customization
   - Suggestion preview improvements

### Lower Priority (Larger Features)

7. **Integration Features**
   - Integration with other autocomplete plugins
   - API for other plugins to add suggestions
   - Sync with external dictionaries

8. **Advanced Learning**
   - Machine learning-based suggestions
   - Adaptive suggestion ranking
   - User preference learning

## License

This plugin is released under the MIT License. See LICENSE file for details.

## Author

Quantavil - https://github.com/quantavil/

## Support

For issues, questions, or feature requests, please create an issue on the GitHub repository.
