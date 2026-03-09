import type { FuzzyResult } from "./types";

export class TrieNode {
	public readonly children = new Map<string, TrieNode>();
	public word: string | null = null;
}

export class Trie {
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

	public has(word: string): boolean {
		if (!word) return false;
		let node = this.root;
		for (const ch of word.toLowerCase()) {
			const next = node.children.get(ch);
			if (!next) return false;
			node = next;
		}
		return node.word !== null;
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
